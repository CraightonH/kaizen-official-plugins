# `llm-tui` — Generic LLM Chat TUI (Spec 13)

**Status:** draft
**Date:** 2026-04-30
**Scope:** Tier 3 (capability) — extracts the generic Ink+React TUI primitives out of `claude-tui` into a harness-agnostic plugin used by the openai-compatible harness (and any future `*-llm` provider harness). Provides the input prompt, output stream, status bar, and a registerable completion popup. Does not implement slash commands, fallback rendering, tool-call formatting, or any other feature beyond the core chat surface.

## Goal

Give every non-claude-wrapper LLM harness a single, reusable terminal UI that:

1. Renders a streaming chat transcript and reads user input.
2. Hosts a completion-popup that any plugin can extend through a public registry (the cornerstone feature, used at minimum by `llm-slash-commands`).
3. Renders status-bar items driven entirely by the existing `status:item-update` / `status:item-clear` events.
4. Stays narrow enough that future TUI features (agent activity tree, code-block rendering, markdown output) live in their own plugins consuming the channel API.

## Non-goals

- Slash command parsing or dispatch — owned by `llm-slash-commands` (Spec 8). The TUI emits `input:submit` and is otherwise content-agnostic.
- Fallback / "claude CLI is down" rendering — claude-tui-specific, not migrated.
- Tool-call formatting, agent activity trees, codemode block rendering — future plugins write to `writeOutput`.
- Backwards compatibility with `claude-tui`. The two plugins coexist; `claude-tui` continues to back the claude-wrapper harness unchanged.
- Mouse support, image rendering, and rich markdown are out of v0.

## Architectural overview

`llm-tui` mounts a single Ink app at plugin startup and exposes four services:

| Service | Owner | Purpose |
|---|---|---|
| `llm-tui:channel` | this plugin | Pull-style I/O surface used by the driver's interactive loop. |
| `llm-tui:completion` | this plugin | Registry of completion sources for the input popup. |
| `llm-tui:status` | this plugin | Marker service; no public methods. Subscribes internally to `status:item-update` / `status:item-clear`. |
| `llm-tui:theme` | this plugin | Read-only theme tokens consumed by the renderers. Configurable per-harness. |

The plugin emits exactly one event into the bus: `input:submit` (vocabulary owned by `llm-events`, Spec 0). Subscribers — `llm-slash-commands`, ultimately the driver — decide what to do with the text. The TUI does not interpret it.

Permissions: `tier: "trusted"` (matches `claude-tui`).

## Reuse and divergence from `claude-tui`

`claude-tui` (`plugins/claude-tui/`) is the structural starting point. The new plugin keeps the same component shape and state pattern but drops claude-specific behaviour.

**Carried over (re-implement, do not symlink):**

- `index.tsx` mount + Ink root component.
- `state/store.ts` reducer-style store for input text, busy flag, transcript buffer, and status-bar items.
- `ui/App.tsx`, `ui/InputBox.tsx`, `ui/SpinnerLine.tsx`, `ui/StatusBar.tsx` — same component tree.
- `public.d.ts` `UiChannel` interface, renamed `TuiChannelService` to disambiguate.

**NOT carried over:**

- `slash.ts` and `slash.test.ts` — slash dispatch moves entirely to `llm-slash-commands`. The TUI does not parse `/`.
- `fallback.ts` — claude-CLI-down rendering is harness-specific.
- Any reference to `claude-events:vocabulary`. The new plugin imports `llm-events:vocabulary` and the `Vocab` type from Spec 0.

**New in this plugin:**

- `completion/registry.ts` — implementation of `llm-tui:completion`.
- `ui/CompletionPopup.tsx` — popup component rendered beneath `InputBox`.
- `theme/loader.ts` — reads `~/.kaizen/plugins/llm-tui/config.json` if present, merges over defaults.

## Service interfaces

All types live in `plugins/llm-tui/public.d.ts`. They reference shared types from `llm-events` (Spec 0) where applicable; nothing in this spec introduces new cross-plugin types beyond the four below.

### `llm-tui:channel`

The pull-style I/O surface. The driver's interactive loop calls `readInput()` to block on the next user line, then writes assistant tokens via `writeOutput`. `writeNotice` is for ephemeral system-style messages (e.g. "model switched to gpt-4o"). `setBusy` toggles the spinner and an optional inline message.

```ts
export interface TuiChannelService {
  writeOutput(chunk: string): void;
  writeNotice(text: string): void;
  setBusy(state: boolean, message?: string): void;
  readInput(): Promise<string>;
}
```

`readInput` resolves on the next `input:submit` event. The TUI MAY queue submits if `readInput` is not currently awaited — implementation chooses between queueing and dropping; v0 queues with no upper bound and trusts the driver to drain.

`writeOutput` accepts arbitrary text including ANSI escape codes already produced by upstream callers. Newline handling: chunks are appended verbatim; renderer wraps to terminal width. No markdown parsing in v0.

### `llm-tui:completion`

The marquee feature. See "Completion popup UX" below for behaviour. Interface mirrors the `TuiCompletionService` contract introduced in Spec 0.

```ts
export interface CompletionItem {
  label: string;        // visible row, e.g. "/help"
  detail?: string;      // dim text right of label, e.g. "show available commands"
  insertText: string;   // replacement string (full text including trigger if appropriate)
  sortWeight?: number;  // higher = earlier; default 0
}

export interface CompletionSource {
  id: string;                   // unique id, used for deregistration logging
  trigger: string;              // single character, e.g. "/" or "@"
  // Called when the popup needs items. `query` is the text after the trigger
  // up to the cursor. Implementations should be cheap; results may be cached
  // by the registry between keystrokes within the same trigger session.
  list(query: string): CompletionItem[] | Promise<CompletionItem[]>;
}

export interface TuiCompletionService {
  register(source: CompletionSource): () => void;  // returns unregister
}
```

A single trigger character may have multiple sources (e.g. both slash commands and a future `@file` source registering under different triggers; or two plugins both registering `/`). The registry merges results across all sources for the active trigger.

### `llm-tui:status`

Marker only. The plugin subscribes once at startup to `status:item-update` and `status:item-clear` (Spec 0 vocabulary, "Status" section) and renders the current item map into `StatusBar`. No methods are exposed; consumers stay decoupled by emitting events.

```ts
// public.d.ts — no service methods, kept solely so harness consumers can
// require the service name to assert the status bar is wired up.
export interface TuiStatusService {}
```

### `llm-tui:theme`

```ts
export interface TuiTheme {
  promptLabel: string;     // default "llm"
  promptColor: string;     // default "cyan"
  outputColor: string;     // default "white"
  noticeColor: string;     // default "yellow"
  busyColor: string;       // default "magenta"
  statusBarColor: string;  // default "gray"
}

export interface TuiThemeService {
  current(): TuiTheme;
}
```

Theme is read once at mount and on every config-file change (no hot-reload in v0; restart picks up changes). All colour fields accept either a named Ink colour or a `#rrggbb` hex string.

## Configuration

File: `~/.kaizen/plugins/llm-tui/config.json` (optional). Schema:

```json
{
  "theme": {
    "promptLabel": "kaizen",
    "promptColor": "#7aa2f7",
    "outputColor": "white",
    "noticeColor": "yellow",
    "busyColor": "magenta",
    "statusBarColor": "gray"
  }
}
```

Loader behaviour:

- Missing file or unreadable: use baked-in defaults silently.
- Malformed JSON or unknown fields: log a notice via `writeNotice` after mount, fall back to defaults for the bad fields, accept the rest.
- Per-harness defaults can be supplied by the plugin's `defaultConfig` block in `plugin.json`, applied before the user's config (user wins on conflict).

## Completion popup UX

This is the load-bearing user-facing feature of the plugin. The behaviour below is normative.

### Trigger

1. The popup opens when the user types a registered trigger character at **word-start** — meaning the previous character is either nothing (cursor at column 0) or whitespace.
2. Trigger character INSIDE a word (e.g. `foo/bar`) does not open the popup.
3. Trigger character inside backticks or matching quote pairs (`"…"`, `'…'`) does not open the popup. Detection is naive linear scan from the start of the line; nested quoting edge cases fall back to "open" rather than "skip".
4. If two sources register different trigger characters, both work independently.
5. The popup never opens for a trigger character that has no registered sources.

### Filtering

1. Once open, the popup tracks the substring between the trigger and the cursor as the live `query`.
2. Each registered source for the active trigger is called with the current `query`. Calls are debounced ~50ms across keystrokes to avoid thrash. Async sources are awaited; if a newer keystroke arrives mid-await, the older result is discarded.
3. Items from all sources are concatenated, then sorted by `sortWeight` desc, then by `label` asc. The registry does not deduplicate; sources are responsible for their own namespace.
4. If the merged list is empty, the popup remains visible showing `no matches` in the notice colour, and does NOT block input.

### Navigation and acceptance

1. Up / Down arrows move the selection by one row, wrapping at top and bottom.
2. Enter accepts the selection: replace the substring from the trigger character through the cursor with `insertText`, place the cursor at the end of the inserted text, close the popup. Enter does NOT also submit the input.
3. Tab is a synonym for Enter (terminal convention).
4. If Enter is pressed with the popup open but no items match, the popup closes and the keystroke falls through to normal input submission. (This rule is what lets users type `/notarealcommand` and submit it as plain text.)
5. Esc closes the popup. The typed trigger and query remain in the input buffer; the user keeps typing.
6. Backspacing past the trigger character closes the popup naturally. Backspacing within the query updates the filter live.

### Multi-byte characters

Item labels and `insertText` may contain multi-byte and emoji characters. Ink/yoga handle width measurement; the spec calls out that we must include at least one test case with a CJK label to lock the contract.

### Concurrency and lifecycle

- Sources may register and unregister at any time. If an active session's sources change, the registry refreshes the current item list on the next debounced tick.
- The popup is a child of `InputBox` in the component tree. It overlays the next N rows of the terminal; v0 caps display at 8 visible items with a `… N more` row when overflowing.

## Component tree

```
<App>                                 // root; subscribes to store
  <TranscriptView />                  // scrollable buffer of writeOutput / writeNotice lines
  <SpinnerLine />                     // visible only while busy
  <InputBox>                          // textinput w/ prompt label
    <CompletionPopup />               // overlay; rendered iff popup is open
  </InputBox>
  <StatusBar />                       // map of status-key → status-value
</App>
```

Store shape (`state/store.ts`):

```ts
interface TuiState {
  transcript: TranscriptLine[];        // { kind: "output" | "notice"; text: string }
  busy: { active: boolean; message?: string };
  input: { value: string; cursor: number };
  popup: PopupState | null;            // { trigger, query, items, selectedIndex }
  status: Record<string, string>;
}
```

The store is updated by:

- `TuiChannelService` methods (output, notice, busy).
- Ink keypress handlers in `InputBox` (input value, cursor, submit).
- The completion registry's debounced refresher (popup items).
- The status-event subscriber (`status:item-update`, `status:item-clear`).

No external state; tests instantiate the store directly.

## Event interaction summary

| Direction | Event | Notes |
|---|---|---|
| Out | `input:submit` | Emitted on Enter when the popup is closed (or when popup is open but no items match). Payload `{ text: string }` per Spec 0 input vocabulary. |
| In | `status:item-update` | Sets `state.status[key] = value`. |
| In | `status:item-clear` | Deletes `state.status[key]`. |

No other events are produced or consumed by this plugin. The driver, slash plugin, and other consumers compose their own behaviour on top of `input:submit` and the channel service.

## Test plan

Unit:

- `state/store.test.ts` — every reducer action.
- `completion/registry.test.ts` — register / unregister, merging, sort weight, debouncing semantics, async source cancellation when query changes mid-flight.
- `theme/loader.test.ts` — default fallback, malformed JSON tolerance, per-harness default merging.
- `ui/CompletionPopup.test.tsx` — render with 0/1/many items, selection wraparound, no-match state, multi-byte label width, overflow `… N more` row.
- `ui/InputBox.test.tsx` — popup open conditions (word-start, inside word, inside quotes), Enter/Tab/Esc handling, backspace-past-trigger behaviour, Enter-falls-through when no matches.
- `ui/StatusBar.test.tsx` — items rendered in stable key order; clear removes item.

Integration:

- `index.test.ts` — full plugin lifecycle: mount, register a fake completion source, drive the input via simulated keypresses, assert `input:submit` emission and store transitions.
- Cross-plugin smoke test (lives in the harness's e2e suite, referenced here): bring up A-tier harness with `llm-tui` + `llm-slash-commands`, assert that typing `/he` produces a popup including the `help` command and that Enter inserts `/help ` and a second Enter submits it.

Manual:

- Run the openai-compatible A-tier harness, type, see streaming output, see status items appear and clear, exit via Ctrl-C.

## Acceptance criteria

- A-tier harness (Spec 0 composition) substitutes `llm-tui` for `claude-tui` and the chat experience works end-to-end with no other harness changes.
- B-tier harness with `llm-slash-commands` registered shows working `/`-triggered autocomplete using only the public `llm-tui:completion` API. The slash plugin must NOT read TUI internals.
- `claude-tui` is unaffected: `claude-wrapper.json` and the claude-wrapper harness continue to ship unchanged, including the slash and fallback behaviour native to that plugin.
- `~/.kaizen/plugins/llm-tui/config.json` themes the UI without code changes; deleting it restores defaults.
- All unit and integration tests pass under the existing Bun test runner used by other plugins in the repo.
- Plugin published to the marketplace catalog (`marketplace.json` updated) at the same time the first dependent harness ships.

## Open questions

1. **Rich-output API.** Should `writeOutput` grow `writeMarkdown(md)` and `writeCodeBlock({ language, code })` helpers, or should consumer plugins (a future `llm-formatting` plugin, or `llm-codemode-dispatch` directly) be responsible for ANSI-formatting their text before calling `writeOutput`? Leaving this for a follow-up; v0 is text-only.
2. **Agent activity tree.** When `llm-agents` lands and we need to visualize nested-turn progress, is that a new plugin that consumes `llm-tui:channel` (and `turn:start` / `turn:end` events) and renders a tree into the transcript area, or does `llm-tui` need a dedicated extension point (e.g. a `registerOverlay(component)` API)? Leaving for the agents spec to resolve.
3. **Mouse support.** Ink supports mouse events. v0 is keyboard-only; revisit once we have a concrete user request.
4. **Popup placement at terminal bottom.** When the input box sits within one row of the terminal bottom, the popup has nowhere to render below. v0 spec says: render above the input in that case. Implementation detail or contract? Calling it a contract here so tests can lock it.
5. **Queue policy on `readInput` not awaited.** v0 queues unboundedly. Should there be a backpressure or drop-oldest policy? Defer until we see a real-world overflow.
6. **Hot-reload of theme config.** v0 requires restart. A future watcher could call back into the theme service. Defer.
