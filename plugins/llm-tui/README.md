# llm-tui

Generic Ink+React chat TUI for non-claude-wrapper LLM harnesses. Renders a streaming transcript, an input prompt, a status bar, a live thinking buffer, and an extensible completion popup. Slash-command parsing, fallback rendering, tool-call formatting, and markdown are deliberately out of scope — those live in peer plugins that compose against the public services.

## What it does

- Mounts a single Ink app at plugin setup and tears it down on stop.
- Renders a transcript of `output`, `notice`, `user`, and `thoughts` lines, a busy spinner with optional message, an input box with cursor, and a status bar.
- Accumulates streaming reasoning deltas into a live thinking box above the input; finalizes them into a collapsed `Thoughts` block in the transcript when the turn ends.
- Hosts a registerable completion popup beneath the input. Multiple sources may register against any single-character trigger; results are merged, debounced (~50ms), and sorted by `sortWeight` desc then `label` asc.
- Renders the status bar from a key/value map driven entirely by status events (no public method to mutate it).
- Loads theme tokens from `~/.kaizen/plugins/llm-tui/config.json` (overridable via `KAIZEN_LLM_TUI_CONFIG`), merged over harness-supplied defaults from plugin config, merged over baked-in defaults.
- Falls back to a line-oriented readline channel when stdin/stdout is not a TTY: `writeOutput` → stdout, `writeNotice` → stderr, `writeUser` → `> {text}`, busy/thinking are no-ops, `readInput` reads a line.
- On Ctrl+C: emits `turn:cancel` if busy, otherwise exits the process.

## Wiring

### Provides

**Service** — `llm-tui:channel`

```typescript
interface TuiChannelService {
  writeOutput(chunk: string): void;
  writeNotice(text: string): void;
  writeUser(text: string): void;
  setBusy(state: boolean, message?: string): void;
  readInput(): Promise<string>;
  appendReasoning(delta: string): void;
  finalizeReasoning(): void;
  clearLiveThinking(): void;
}
```

Semantics:
- `readInput()` resolves on the next user submit. Submits arriving while no reader is awaiting are queued unboundedly — drivers are expected to drain.
- `writeOutput` appends verbatim including ANSI escapes. No markdown parsing. The renderer wraps to terminal width.
- `writeUser` is a transcript helper for echoing the user's own line back with the prompt accent; the TUI does not auto-echo on submit.
- `setBusy(true, msg?)` shows the spinner; `setBusy(false)` hides it.
- The TUI does NOT emit `input:submit` itself — submitted lines are handed to the consumer via `readInput()`. The consumer owns the event emission (this avoids a double-dispatch race against reentrant slash handlers).

**Service** — `llm-tui:completion`

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

interface TuiCompletionService {
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

**Service** — `llm-tui:status`

Marker only — no methods. Consumers may declare a dependency on the service name to assert the status bar is wired up. The bar is updated by event subscriptions (see "Consumes").

```typescript
interface TuiStatusService {}
```

**Service** — `llm-tui:theme`

```typescript
interface TuiTheme {
  promptLabel: string;
  promptColor: string;
  outputColor: string;
  noticeColor: string;
  busyColor: string;
  statusBarColor: string;
}

interface TuiThemeService {
  current(): TuiTheme;
}
```

Read once at mount. No hot reload — restart picks up config changes. Colour fields accept named Ink colours or `#rrggbb` hex.

### Consumes

**Service** — `llm-events:vocabulary`. The vocabulary is a hard dependency: it owns the event names this plugin subscribes to and the names consumers should use to drive the channel.

**Events subscribed:**
- `status:item-update` — `{ key, value }` → upserts the bar entry.
- `status:item-clear` — `{ key }` → removes the bar entry.
- `llm:reasoning` — `{ delta }` → appends to the live thinking buffer.
- `llm:done` — finalizes accumulated reasoning into a `Thoughts` transcript block.
- `turn:end` — clears any in-flight thinking buffer (belt-and-suspenders for streams that error before `llm:done`).

**Events emitted:**
- `turn:cancel` — emitted on Ctrl+C while `busy` is active. The plugin emits no other events; `input:submit` is owned by the channel consumer.

## Configuration

| Var / file | Effect |
|------------|--------|
| `~/.kaizen/plugins/llm-tui/config.json` | Optional `{ theme: { ... } }` overrides. Missing → defaults silently. Malformed JSON → notice logged, defaults applied. Unknown / invalid colour fields → ignored individually, valid fields kept. |
| `KAIZEN_LLM_TUI_CONFIG` | Override the config file path. |
| `defaultConfig.theme` in `plugin.json` | Per-harness defaults; merged over baked-in defaults, then user config wins on conflict. |

## Permissions

`tier: unscoped` — owns the terminal (raw mode, full-screen Ink render) and reads a config file under the user's home directory.
