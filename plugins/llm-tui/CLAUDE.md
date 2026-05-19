# Working in `llm-tui`

Notes for agents editing this plugin. See `README.md` for the user-facing contract.

## Module map

```
index.tsx              Plugin lifecycle. Defines the four services, loads theme, builds the
                       store + completion registry, wires event subscriptions, mounts Ink (or
                       falls back to readline), provides the channel. Only file that touches `ctx`.
fallback.ts            createFallbackChannel() → UiChannelService for non-TTY environments
                       (writes to stdout/stderr, reads lines via readline). Pure; no React.
public.d.ts            Plugin-internal types — ToolCallStatus, CompletionItem, CompletionSource.
                       Contract types (UiChannelService, UiCompletionService, UiStatusService,
                       UiThemeService, UiTheme, UiToolRendererService, UiToolRenderer) now
                       live in llm-contracts/public.
state/store.ts         TuiStore class. Single source of truth: transcript, busy, input,
                       popup, status map, history, live thinking. Subscriber pattern; produces
                       immutable snapshots. Owns the readInput() queue/pending-resolver pair.
                       Pure (no React, no ctx).
completion/registry.ts makeCompletionRegistry({ debounceMs? }) → { service, query }. Stateful
                       closure: source map by id, debounce timer, monotonic token for async
                       cancellation. Pure logic; no React, no ctx.
theme/loader.ts        loadTheme(deps) → UiTheme. DI-friendly (deps inject readFile/env/log).
                       realThemeDeps(log, harnessDefaults) supplies the real ones at mount.
                       DEFAULT_THEME is the baked-in floor.
ui/App.tsx             Root component. Subscribes to TuiStore via useSyncExternalStore.
                       Composes TranscriptView, ThinkingBox, SpinnerLine, InputBox,
                       CompletionPopup, StatusBar.
ui/InputBox.tsx        textinput w/ prompt label. Owns keypress → store mutations.
                       Detects popup-open conditions (word-start trigger, not-in-quotes).
                       Handles Up/Down/Enter/Tab/Esc/Backspace popup interactions and the
                       Enter-falls-through-on-zero-matches rule.
ui/CompletionPopup.tsx Renders popup items, selection highlight, `… N more` overflow row,
                       no-match notice. Picks above/below input based on terminal rows.
ui/SpinnerLine.tsx     Spinner + busy message; visible iff state.busy.active.
ui/StatusBar.tsx       Renders status map in stable key order.
ui/ThinkingBox.tsx     Live thinking buffer rendered above the input while populating.
ui/ThoughtsBlock.tsx   Collapsed Thoughts transcript entry; Ctrl+R toggles the most-recent block.
```

Boundaries:
- `state/store.ts`, `completion/registry.ts`, and `theme/loader.ts` are the only stateful non-UI modules. All three are framework-free (no React, no `ctx`).
- Only `index.tsx` imports `kaizen/types` or touches `ctx`.
- UI components read from the store via `useSyncExternalStore` (subscribe + snapshot). Never reach into `ctx` from a component.
- Tests for each module live alongside it (`*.test.ts(x)`) and run independently under `bun test`.

## Invariants

- **Snapshot identity is the React signal.** `TuiStore` rebuilds `_snapshot` on every mutation and emits to subscribers. Components rely on referential inequality to re-render — never mutate a snapshot field in place.
- **The TUI does NOT emit `input:submit`.** Submitted lines are handed to the consumer via `readInput()`; the consumer owns the event. Re-introducing an emit here re-creates the double-dispatch race that the comment in `index.tsx` exists to prevent.
- **`readInput` queues unboundedly.** A submit arriving while no reader is awaiting goes onto `_queue`. The driver must drain. Don't add a bound without coordinating with consumers.
- **Popup never submits.** Enter/Tab on a selection only inserts text and closes; submission requires a separate Enter with the popup closed (or open-with-zero-matches fall-through).
- **Trigger detection is naive.** Inside-word / inside-quotes / inside-backticks suppression is a linear scan from line start. Edge cases bias toward "open" rather than "skip" — keep it that way; full lexing is out of scope.
- **Source `list()` errors are swallowed per-source.** Other sources for the same trigger still contribute. Don't surface these as notices.
- **Theme is read-once.** No hot reload. If you add a watcher, keep `current()` returning a stable reference between mutations so consumers can cache.
- **Fallback channel matches TTY channel shape.** Adding a method to `UiChannelService` requires adding a (possibly no-op) implementation to `fallback.ts` in the same change.
- **Status bar has no public mutator.** All updates go through `status:item-update` / `status:item-clear`. Adding a method bypassing the event bus breaks the decoupling guarantee.
- **Reasoning lifecycle is tri-state.** `llm:reasoning` deltas accumulate; `llm:done` finalizes into a Thoughts block; `turn:end` clears unfinalized buffers. All three handlers must remain symmetric or the thinking box leaks across turns.
- **Markdown rendering is per-entry, render-time.** Output entries default `markdown: true`; notice/user default `false`. Caller passes `{ markdown: bool }` on the write to override. Thoughts ignore the per-entry flag and are governed by `theme.thoughtsMarkdown` (default true); the live `ThinkingBox` is always plain regardless. `dimColor` is dropped for markdown notices and rendered thoughts.

## Adding a completion source from another plugin

```typescript
const completion = ctx.useService<UiCompletionService>("ui:completion-source");
const off = completion.register({
  id: "my-plugin:my-source",     // unique; reuse the namespace `<plugin>:<source>`
  trigger: "/",                  // single character; word-start to open popup
  list: async (query) => {
    return [
      { label: "/foo", detail: "do the foo", insertText: "/foo ", sortWeight: 100 },
    ];
  },
});

// On teardown:
off();
```

Use a namespaced `id` to avoid collisions; the registry indexes by id and a re-register with the same id silently replaces the prior source.

## Driving the channel from a harness

```typescript
const tui = ctx.useService<UiChannelService>("ui:channel");

// Interactive loop:
for (;;) {
  const line = await tui.readInput();
  await ctx.emit("input:submit", { text: line });   // consumer owns this emit
  tui.setBusy(true, "thinking…");
  // …drive the model, call tui.writeOutput() for each chunk…
  tui.setBusy(false);
}
```

The consumer is responsible for echoing user lines via `writeUser()` if desired; the TUI does not auto-echo on submit.

## Editing UI components

- Read store state via `useSyncExternalStore(store.subscribe, store.snapshot)`. Snapshots are stable references between mutations; selectors should be pure projections, not memoized closures over `store.snapshot()`.
- Keypress handling lives in `InputBox`. Don't scatter `useInput` calls across multiple components — Ink will fight over keystrokes.
- Width-sensitive renders (CJK, emoji) must round-trip through Ink/yoga. There is at least one CJK test in `ui/CompletionPopup.test.tsx` locking this; keep it.

## Testing

```bash
cd plugins/llm-tui && bun test
```

- `state/store.test.ts` covers every reducer-style mutation and the `readInput` queue/await pair.
- `completion/registry.test.ts` covers register/unregister, debouncing, async cancellation by token, and per-source error swallowing.
- `theme/loader.test.ts` uses injected `ThemeDeps` — never the real filesystem.
- UI tests use `ink-testing-library` (`render`, `lastFrame`); avoid driving the real terminal.
- `index.test.ts` is the lifecycle smoke test (mount, register a fake source, simulate keypresses, assert store transitions). Use the fake-`ctx` helper there rather than spinning up a real Kaizen runtime.
- `integration.test.ts` runs the cross-component flow without Ink — store + registry + simulated input only.

## Local deploy

The Kaizen runtime prefers the bundled `dist/index.js` over source. After editing, copy and re-bundle into the install dir:

```bash
cp -R plugins/llm-tui/. ~/.kaizen/marketplaces/official/plugins/llm-tui@0.2.0/
(cd ~/.kaizen/marketplaces/official/plugins/llm-tui@0.2.0 \
  && bun build --target=bun --outfile=dist/index.js index.tsx)
```

Note: entry is `index.tsx` (not `.ts`) — the bundler must run on the TSX file. If the harness manifest needs to pick up new exports or the version bumps, sync the local marketplace repo (`~/.kaizen/marketplaces/official/repo/`) — `kaizen marketplace update` will overwrite local edits there.

**External plugins must not register `ui:tool-renderer`s that return JSX.** Kaizen bundles each plugin hermetically with its own React, so a JSX node built in another plugin's bundle uses a different React instance than the one this plugin's Ink reconciler runs. The result is `dispatcher.useContext is null` at render time. Renderers for cross-plugin tools should live here in `tool-renderers/defaults.tsx` (the `execute_typescript` renderer for `llm-codemode` is an example). If a future external plugin needs custom rendering, change the `ui:tool-renderer` contract to return a framework-neutral structured view instead of `ReactNode`.
