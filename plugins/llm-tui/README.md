# llm-tui

Generic Ink+React chat TUI for non-claude-wrapper LLM harnesses. Renders a streaming transcript, an input prompt, a status bar, a live thinking buffer, live/finalized tool calls, and an extensible completion popup. Slash-command parsing and markdown are deliberately out of scope — those live in peer plugins that compose against the public services.

## What it does

- Mounts a single Ink app at plugin setup and tears it down on stop.
- Renders a transcript of `output`, `notice`, `user`, `thoughts`, and `tool_call` lines, a busy spinner with optional message/timing/token count, an input box with cursor, and a status bar.
- Accumulates streaming reasoning deltas into a live thinking box above the input; finalizes them into a collapsed `Thoughts` block in the transcript when the turn ends.
- Tracks tool lifecycle events as live tool-call rows and finalizes them into transcript entries. Built-in renderers cover common local tools; peer plugins can register richer renderers.
- Hosts a registerable completion popup beneath the input. Multiple sources may register against any single-character trigger; results are merged, debounced (~50ms), and sorted by `sortWeight` desc then `label` asc.
- Renders the status bar from a key/value map driven entirely by status events (no public method to mutate it).
- Loads theme tokens from `~/.kaizen/plugins/llm-tui/config.json` (overridable via `KAIZEN_LLM_TUI_CONFIG`), merged over harness-supplied defaults from plugin config, merged over baked-in defaults.
- Falls back to a line-oriented readline channel when stdin/stdout is not a TTY: `writeOutput` → stdout, `writeNotice` → stderr, `writeUser` → `> {text}`, busy/timing/thinking/draft methods are no-ops, `readInput` reads a line.
- Esc emits `turn:cancel` while busy. Ctrl+C is two-step: first press cancels a busy turn and/or clears the input, second press within the exit window exits the process.

## Wiring

### Provides

**Service** — `ui:channel`

```typescript
interface UiChannelService {
  writeOutput(chunk: string): void;
  writeNotice(text: string): void;
  writeUser(text: string): void;
  setBusy(state: boolean, message?: string): void;
  setBusyTiming(startedAt: number): void;
  updateBusyTokens(deltaTokens: number): void;
  incrementBusyTokens(n?: number): void;
  readInput(): Promise<string>;
  appendReasoning(delta: string): void;
  finalizeReasoning(): void;
  clearLiveThinking(): void;
  setInputDraft(text: string): void;
}
```

Semantics:
- `readInput()` resolves on the next user submit. Submits arriving while no reader is awaiting are queued unboundedly — drivers are expected to drain.
- `writeOutput` appends verbatim including ANSI escapes. No markdown parsing. The renderer wraps to terminal width.
- `writeUser` is a transcript helper for echoing the user's own line back with the prompt accent; the TUI does not auto-echo on submit.
- `setBusy(true, msg?)` shows the spinner; `setBusy(false)` hides it.
- `setBusyTiming(startedAt)` enables elapsed-time display for the active busy period.
- `updateBusyTokens(n)` replaces the displayed completion-token count; `incrementBusyTokens(n?)` increments it during streaming.
- `setInputDraft(text)` replaces the editable input buffer and places the cursor at the end. In non-TTY fallback mode it is a no-op.
- The TUI does NOT emit `input:submit` itself — submitted lines are handed to the consumer via `readInput()`. The consumer owns the event emission (this avoids a double-dispatch race against reentrant slash handlers).

**Service** — `ui:completion-source`

```typescript
interface CompletionItem {
  label: string;
  detail?: string;
  insertText: string;
  sortWeight?: number;
}

interface CompletionSource {
  id: string;
  trigger: string;                  // single character, e.g. "/" or "@"
  list(query: string): CompletionItem[] | Promise<CompletionItem[]>;
}

interface UiCompletionService {
  register(source: CompletionSource): () => void;
}
```

Semantics:
- Popup opens when `trigger` is typed at word-start (cursor at column 0 or preceded by whitespace) and at least one source is registered for it. Trigger inside a word, inside backticks, or inside matched quotes does not open the popup.
- `query` is the substring between the trigger and the cursor; backspacing past the trigger closes the popup.
- Up/Down navigate (wraparound), Enter/Tab accept (replaces trigger..cursor with `insertText`, places cursor at end, closes popup, does NOT submit), Esc closes leaving text intact.
- Enter with the popup open and zero matches falls through as a normal submit — this is what lets users send `/notarealcommand` as plain text.
- Display caps at 8 visible items with a `… N more` overflow row. When the input is within one row of the terminal bottom, the popup renders above instead of below.
- Sources may register/unregister at any time. The active session refreshes on the next debounce tick.
- A source's `list()` throwing is swallowed; that source contributes zero items for that query.

**Service** — `ui:status`

Marker only — no methods. Consumers may declare a dependency on the service name to assert the status bar is wired up. The bar is updated by event subscriptions (see "Consumes").

```typescript
interface UiStatusService {}
```

**Service** — `ui:theme`

```typescript
interface UiTheme {
  promptLabel: string;
  promptColor: string;
  outputColor: string;
  noticeColor: string;
  busyColor: string;
  statusBarColor: string;
}

interface UiThemeService {
  current(): UiTheme;
}
```

Read once at mount. No hot reload — restart picks up config changes. Colour fields accept named Ink colours or `#rrggbb` hex.

**Service** — `ui:tool-renderer`

```typescript
type ToolCallStatus = "running" | "done" | "error";

interface UiToolRenderer {
  toolName: string;
  collapsedSummary(args: unknown): string;
  expandedView?(
    args: unknown,
    result: string | undefined,
    status: ToolCallStatus,
    stdout: string,
  ): React.ReactNode | null;
}

interface UiToolRendererService {
  register(renderer: UiToolRenderer): () => void;
}
```

Semantics:
- Renderers are keyed by exact tool name. Re-registering a tool name replaces the previous renderer.
- `collapsedSummary` renders the one-line header while the call is running and after it finalizes.
- `expandedView` is consulted only for terminal states. Returning `null` keeps the tool call to the one-line summary.
- The unregister closure is reference-scoped: it removes only the renderer registered by that call.
- Built-in renderers are registered for `edit`, `write`, `create`, and `bash`; peer plugins can override them by registering the same `toolName`.

### Consumes

**Service** — `events:vocabulary`. The vocabulary is a hard dependency: it owns the event names this plugin subscribes to and the names consumers should use to drive the channel.

**Events subscribed:**
- `status:item-update` — `{ key, value }` → upserts the bar entry.
- `status:item-clear` — `{ key }` → removes the bar entry.
- `llm:reasoning` — `{ delta }` → appends to the live thinking buffer.
- `llm:token` — increments the live completion-token estimate.
- `llm:done` — finalizes accumulated reasoning into a `Thoughts` transcript block and applies authoritative completion-token usage when present.
- `turn:end` — clears any in-flight thinking buffer, live tool calls, and busy timing state.
- `session:handoff` — with `autostart=false`, prefills the input draft; otherwise appends the seeded prompt as a user transcript line with an optional handoff badge.
- `tool:execute` — `{ callId, name, args }` → starts a live tool-call row.
- `tool:progress` — `{ callId, delta }` → appends streamed stdout to the live row.
- `tool:result` — `{ callId, name?, result }` → finalizes the tool call as `done`.
- `tool:error` — `{ callId, name?, message }` → finalizes the tool call as `error`.
- `tui:enter-history` — enters the audit/history view. This plugin defines the event; slash-command peers may emit it.

**Events emitted:**
- `turn:cancel` — emitted on Esc or first Ctrl+C while `busy` is active. The plugin emits no other events; `input:submit` is owned by the channel consumer.

## Configuration

| Var / file | Effect |
|------------|--------|
| `~/.kaizen/plugins/llm-tui/config.json` | Optional `{ theme: { ... } }` overrides. Missing → defaults silently. Malformed JSON → notice logged, defaults applied. Unknown / invalid colour fields → ignored individually, valid fields kept. |
| `KAIZEN_LLM_TUI_CONFIG` | Override the config file path. |
| `defaultConfig.theme` in `plugin.json` | Per-harness defaults; merged over baked-in defaults, then user config wins on conflict. |

## Permissions

`tier: unscoped` — owns the terminal (raw mode, full-screen Ink render) and reads a config file under the user's home directory.
