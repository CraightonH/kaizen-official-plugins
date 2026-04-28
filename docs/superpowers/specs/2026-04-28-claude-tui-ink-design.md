# claude-tui: Ink-based rework

**Issue:** [CraightonH/kaizen-official-plugins#5](https://github.com/CraightonH/kaizen-official-plugins/issues/5)
**Target version:** `claude-tui` 0.2.0
**Status:** design approved, awaiting implementation plan

## Problem

`claude-tui` 0.1.x uses `node:readline` and an ANSI string builder. Symptoms:

- Keystrokes echo on the line *below* the rounded prompt box, not inside it.
- Assistant text streams below the prompt, leaving the original prompt frozen above.
- Status-bar refreshes repaint the whole prompt block.

We want Claude Code's behavior: cursor inside the box, scrollback above, status line below, multi-line input, history recall.

## Scope

**In:** rewrite `plugins/claude-tui/` on [Ink](https://github.com/vadimdemedes/ink); preserve `UiChannel` public API; multi-line input, paste, terminal resize, in-memory history, two PoC slash commands. *(Parity + free wins from Ink — no new display modes or commands.)*

**Out:** persisted history, inline tool-call cards, in-context editing, generalized slash-command plugin architecture, faithful SGR→Ink color translation. All deferred to follow-up issues.

## Layout

```
<Static>                  scrollback (assistant text, notices, thinking)
✻ msg…                    ephemeral spinner line (when busy)
╭─────────────╮
│ ❯ input     │           rounded box, magenta border, cursor inside,
╰─────────────╯           expands vertically with multi-line
status items · main       single status line below
```

Spinner lives above the input box, in the scrollback flow — not inside the box. The input box stays the user's space at all times.

## Module layout

```
plugins/claude-tui/
  index.ts            mount Ink app, expose UiChannel impl, glue
  ui/
    App.tsx           top-level: <Static> log + spinner + <InputBox> + <StatusBar>
    InputBox.tsx      rounded box, ❯ prompt, useInput, multi-line, history
    StatusBar.tsx     subscribes to status item map
    SpinnerLine.tsx   ephemeral "✻ msg…" line above InputBox when busy
  state/
    store.ts          event-emitter store: log, status items, busy, history, pending input
  slash.ts            handles /clear locally, forwards everything else
  index.test.ts       UiChannel contract (kept, lightly updated)
  ui/App.test.tsx     ink-testing-library behavior tests (stdin → lastFrame)
```

`public.d.ts` (`UiChannel` interface) is unchanged. `claude-driver` and `claude-wrapper` are not touched.

Old files removed: `render.ts`, `input.ts`, `render.test.ts`.

## Dependencies

**New runtime:** `ink@^7`, `react@^19`.
**New dev:** `ink-testing-library@^4`, `@types/react`.

Compatibility verified by smoke test under Bun 1.3.11: render of a magenta rounded box exits clean; `useInput` keystrokes via `ink-testing-library`'s `stdin.write` are observed in `lastFrame()` after an async tick. No native node-gyp deps (Ink 5+ uses `yoga-wasm-web`).

## State bridge (UiChannel ↔ React)

`UiChannel` is imperative; React state is declarative. Bridge with a small event-emitter store outside React; components subscribe via `useSyncExternalStore`.

```ts
// state/store.ts
type LogEntry = { id: number; text: string };
type StatusItem = { id: string; text: string; tone?: "info" | "warn" | "err" };

class TuiStore {
  log: LogEntry[] = [];
  status = new Map<string, StatusItem>();
  busy: { on: boolean; msg?: string } = { on: false };
  history: string[] = [];
  pending: ((line: string) => void) | null = null;  // resolves readInput()

  appendOutput(chunk: string): void;
  appendNotice(line: string): void;
  setBusy(on: boolean, msg?: string): void;
  upsertStatus(item: StatusItem): void;
  clearLog(): void;
  submit(line: string): void;       // history.push, resolve pending
  awaitInput(): Promise<string>;    // assigns pending
}
```

`index.ts` constructs the store, mounts `<App store={store} />`, and returns a `UiChannel` whose methods delegate to store methods. `readInput()` returns `store.awaitInput()`. The Ink `<InputBox>` calls `slash.handle(line)` on Enter; if not swallowed, calls `store.submit(line)`.

Why this shape:
- React is purely a view of the store.
- `readInput()` semantics (one outstanding promise) live in one place.
- Tests can drive the store directly, or render and drive via stdin.

## Components

### `<App>`

```tsx
<Box flexDirection="column">
  <Static items={log}>{e => <Text key={e.id}>{e.text}</Text>}</Static>
  {busy.on && <SpinnerLine msg={busy.msg} />}
  <InputBox />
  <StatusBar />
</Box>
```

### `<Static>` (scrollback)

Append-only. Each `appendOutput(chunk)` is one entry. ANSI escapes pass through raw — Ink's `string-width` is ANSI-aware for measurement. Fallback documented under Risks.

### `<SpinnerLine>`

Uses `ink-spinner` (`✻ msg…`). Mounted only while `busy.on`. Lives outside `<Static>` so it disappears cleanly when busy clears.

### `<InputBox>`

- `<Box borderStyle="round" borderColor="magenta">` — keeps the purple identity from 0.1.x.
- Internal state: `buffer: string`, `cursor: number`, `histIdx: number | null`.
- `useInput` handles:
  - printable chars, backspace, left/right
  - up/down → history recall (in-memory, session-scoped)
  - Enter → submit
  - shift+Enter or trailing `\` → newline in buffer (multi-line; box grows vertically via Yoga)
  - Ctrl+C → forward as exit signal
  - paste → Ink 7 delivers paste blobs as one `input` event with `key.paste`; appended to buffer as-is

### `<StatusBar>`

Single line below the box. Items from `store.status` joined by ` | `, tone applied via `<Text color>`.

### `slash.ts`

Pre-submit interceptor:
- `/clear` → `store.clearLog()`, swallow input, do not resolve `readInput()`.
- `/exit` → forward to channel as a normal submit (caller decides what to do).
- Any other `/...` → forward as plain input.

This respects the project rule that slash commands belong to the shell, not the driver — `/clear` is permitted only because it's a UI-only concern that no other layer can serve.

## Streaming output and ANSI

`appendOutput(chunk)` accepts the chunk verbatim. Ink renders inside `<Text>{chunk}</Text>`. `string-width` strips escapes for measurement, so width is correct in most cases.

Documented risk: Ink's text wrapping can split a chunk mid-SGR, producing visual color bleed after the wrap. If observed, fallback is to add a `strip-ansi` call at the `appendOutput` boundary — a one-line change, no architectural impact. We ship A′ (raw passthrough) and revisit only if the bug manifests.

## Risks and fallbacks

1. **ANSI mid-escape wrap** — fallback: strip ANSI at `appendOutput` boundary. Behavior test streams a colored chunk wider than terminal width.
2. **Terminal resize** — Ink redraws on `SIGWINCH` natively. `<Static>` historical entries are not rewrapped (matches Claude Code).
3. **Paste of large blob** — appended unconditionally; worst case is a slow render, not a crash.
4. **Non-TTY stdin** — when `process.stdin.isTTY === false`, Ink throws on raw mode. Guard at mount: fall back to a non-interactive mode where `readInput()` reads one line from stdin and no rendering occurs. Matches current 0.1.x implicit behavior.
5. **Ctrl+C** — `useInput` receives it; forward through the channel (or `process.exit(130)` if no consumer wired).

## Testing

Behavior tests on the public contract — not snapshots.

`index.test.ts` (kept): construct channel, exercise `UiChannel` methods, assert observable state via store inspection. Does not render.

`ui/App.test.tsx` (new, `ink-testing-library`):

- Typed input shows inside the box (`lastFrame()` contains `❯ hello`).
- Enter resolves the pending `readInput()` with the typed line.
- `/clear` empties the `<Static>` log and does not resolve `readInput()`.
- Up-arrow recalls the last submitted line.
- `setBusy(true, "thinking")` renders `✻ thinking`; `setBusy(false)` removes it.
- `upsertStatus` renders an item in the status bar.
- Multi-line input (shift+Enter) expands the box vertically.
- A colored chunk wider than terminal width does not break subsequent line layout (regression guard for the ANSI risk).

All tests `await tick()` between `stdin.write` calls — required by `ink-testing-library` regardless of runtime.

## Versioning and commit

- `plugins/claude-tui/package.json`: `0.1.2` → `0.2.0`.
- `.kaizen/marketplace.json`: bump claude-tui entry to `0.2.0`.
- Any harness reference to the claude-tui version: bump in lockstep.
- Single PR, message: `feat(claude-tui): rework on Ink for in-box input + scrollback (0.2.0)`. Closes #5.

## Out of scope (follow-ups to file)

- Persisted input history.
- Generalized slash-command plugin / registration API.
- Faithful SGR → Ink color translation for assistant stream.
- Inline tool-call cards, in-context editing.
