# llm-tui colors via kaizen-config

**Status:** design
**Date:** 2026-05-21

## Goal

Make changing TUI colors (and other `UiTheme` fields) "as simple as setting a
config option." Replace `llm-tui`'s private JSON theme loader with a
registration against `kaizen-config`'s `config:store`, so
`/config:set llm-tui promptColor=cyan` is the user-facing path.

Bonus: theme changes apply live (current behavior is read-once at boot).

## Non-goals

- A separate `llm-theme` plugin. The 7-field `UiTheme` contract doesn't justify
  one. May revisit if we add many more tokens or per-component overrides.
- Migrating users from the legacy `~/.kaizen/plugins/llm-tui/config.json` —
  zero known adoption. Hard cut.
- Touching `claude-tui` or other consumers of `UiThemeService`. Same approach
  will apply there but lands in a separate change.
- Extending `kaizen-config`'s schema validators (current `pattern`/`enum` are
  enough for our color values).

## Architecture

`llm-tui` becomes a consumer of `config:store`. The `UiTheme` /
`UiThemeService` contract is unchanged.

```
llm-contracts          (unchanged: UiTheme, UiThemeService)
kaizen-config          provides config:store    ← storage / validation / watch
llm-tui                consumes config:store    ← registers schema, provides ui:theme
```

`llm-tui` manifest delta:

- `services.consumes` gains `"config:store"`.
- `services.consumes` keeps `"slash:registry"` (unchanged elsewhere).
- `permissions.fs` no longer needs anything under `~/.kaizen/plugins/llm-tui/`
  — kaizen-config owns all theme I/O.

## Components

### Deleted

- `plugins/llm-tui/theme/loader.ts`
- `plugins/llm-tui/theme/loader.test.ts`

### New

`plugins/llm-tui/theme/schema.ts` (pure data, no I/O):

```ts
import type { UiTheme } from "llm-contracts/public";
import type { ConfigSchema } from "llm-contracts/public";

const COLOR_PATTERN =
  "^(#[0-9a-fA-F]{6}|black|red|green|yellow|blue|magenta|cyan|white|gray|grey|" +
  "blackBright|redBright|greenBright|yellowBright|blueBright|magentaBright|" +
  "cyanBright|whiteBright)$";

export const BUILT_IN_THEME: UiTheme = {
  promptLabel: "kaizen",
  promptColor: "magenta",
  outputColor: "white",
  noticeColor: "yellow",
  busyColor: "magenta",
  statusBarColor: "gray",
  thoughtsMarkdown: true,
};

export const THEME_SCHEMA: ConfigSchema<UiTheme> = {
  promptLabel:      { type: "string", min: 1, max: 32 },
  promptColor:      { type: "string", pattern: COLOR_PATTERN },
  outputColor:      { type: "string", pattern: COLOR_PATTERN },
  noticeColor:      { type: "string", pattern: COLOR_PATTERN },
  busyColor:        { type: "string", pattern: COLOR_PATTERN },
  statusBarColor:   { type: "string", pattern: COLOR_PATTERN },
  thoughtsMarkdown: { type: "boolean" },
};
```

### Changed

**`plugins/llm-tui/index.tsx`** — replace the `loadTheme(...)` call with:

```ts
const store = ctx.useService<ConfigStoreService>("config:store");
// Harness-supplied defaults are passed via the plugin's config block in the
// harness manifest (today: `ctx.config.theme`). Preserve that shape so existing
// harnesses don't need to be re-keyed.
const harnessDefaults =
  ((ctx.config as { theme?: Partial<UiTheme> } | undefined)?.theme ?? {}) as Partial<UiTheme>;

store.register({
  plugin: "llm-tui",
  defaults: { ...BUILT_IN_THEME, ...harnessDefaults },
  schema: THEME_SCHEMA,
});

let currentTheme = store.get<UiTheme>("llm-tui");
tuiStore.setTheme(currentTheme);

const offWatch = store.watch<UiTheme>("llm-tui", (next) => {
  try {
    currentTheme = next;
    tuiStore.setTheme(next);
  } catch (err) {
    ctx.log(`llm-tui: failed to apply theme update: ${(err as Error).message}`);
  }
});
teardowns.push(offWatch);

ctx.provideService<UiThemeService>("ui:theme", { current: () => currentTheme });
```

If `config:store` is unavailable at setup (shouldn't happen in any real
harness but defend anyway), log a warning, skip `register`/`watch`, and use
`{ ...BUILT_IN_THEME, ...harnessDefaults }` as the static theme. Same shape as
the existing `slash:registry` fallback already in `index.tsx`.

**`plugins/llm-tui/state/store.ts`** — `TuiStore` gains:

- `theme: UiTheme` field on the snapshot
- `setTheme(next: UiTheme)` mutator: replaces `theme`, rebuilds the snapshot,
  notifies subscribers (same pattern as every other reducer-style mutation)

**UI components** that today call `themeService.current()` ad hoc read
`state.theme` from the store snapshot instead. This keeps the
"snapshot identity is the React signal" invariant intact — theme updates flow
through the same `useSyncExternalStore` path as everything else.

### Invariant change in `plugins/llm-tui/CLAUDE.md`

Replace:

> **Theme is read-once.** No hot reload. If you add a watcher, keep
> `current()` returning a stable reference between mutations so consumers can
> cache.

With:

> **Theme lives in the store snapshot.** `config:store.watch("llm-tui")`
> pushes updates into `TuiStore.setTheme()`. `UiThemeService.current()`
> returns the latest value. Components must read `state.theme` from the store
> snapshot, not call `current()` ad hoc, or they'll miss live updates.

## Data flow

```
┌─────────────────────────────────┐
│ ~/.kaizen/harnesses/<key>/      │   (./.kaizen/... for project scope)
│   config.json  { "llm-tui": ...}│
└──────────────┬──────────────────┘
               │ atomic write + fs.watch
               ▼
       ┌──────────────────┐
       │ kaizen-config    │  validate → merge layers → cache
       │   config:store   │
       └──┬───────────┬───┘
   get()  │   watch() │
          ▼           ▼
       ┌──────────────────┐
       │ llm-tui index    │  current UiTheme + push to TuiStore
       └────────┬─────────┘
                │ store.setTheme(next)
                ▼
       ┌──────────────────┐
       │ TuiStore         │  snapshot.theme
       └────────┬─────────┘
                │ useSyncExternalStore
                ▼
       ┌──────────────────┐
       │ UI components    │  re-render with new colors
       └──────────────────┘
```

Write path: `/config:set llm-tui promptColor=cyan` → kaizen-config atomic
write → fs.watch fires → kaizen-config recomputes merged value → watcher
callback in `llm-tui` → `tuiStore.setTheme(next)` → React re-renders.

## Precedence

Effective theme resolves layer-by-layer (kaizen-config's existing behavior):

1. `BUILT_IN_THEME` (compiled-in)
2. Harness defaults (`ctx.config.theme` from the harness manifest, merged
   into the `defaults` passed to `register`)
3. Home config (`~/.kaizen/harnesses/<key>/config.json` → `llm-tui` key)
4. Project config (`./.kaizen/harnesses/<key>/config.json` → `llm-tui` key)
5. Env-var overrides (per-field, declared via the `envVars` arg on `register`
   if/when we want any — none declared in v1)

Same precedence semantics as today (file beats harness beats built-in); we
just gain project scope and env-var overrides for free.

## Error handling

- **`config:store` unavailable at setup.** Log a warning, fall back to
  `{ ...BUILT_IN_THEME, ...harnessDefaults }` as a static theme, no watch, no
  hot reload. Slash command integration still works via kaizen-config's own
  registration if the store ever comes up.
- **Schema validation failure when loading config.json.** kaizen-config logs
  and falls back to defaults (its existing invariant). No new handling.
- **Schema validation failure on `/config:set`.** kaizen-config rejects the
  `set()` call; the slash command surfaces the error string. No new handling.
- **Watcher callback throws.** `try`/`catch` around `tuiStore.setTheme(next)`;
  log via `ctx.log` and keep the last good theme.

## Testing

- Delete `plugins/llm-tui/theme/loader.test.ts`.
- New `plugins/llm-tui/theme/schema.test.ts`: regex accepts every named color
  + `#abcdef` (lower/upper); rejects `purple`, `#abc`, `red123`, empty string.
- Extend `plugins/llm-tui/state/store.test.ts`: `setTheme()` updates the
  snapshot, snapshot identity changes, subscribers fire.
- Extend `plugins/llm-tui/index.test.ts`: stub `config:store`; assert
  `register({ plugin: "llm-tui", ... })` is called with the expected merged
  defaults; simulate a `store.watch` callback; assert
  `tuiStore.snapshot().theme` reflects the new value.
- No real-fs integration test. kaizen-config's own tests cover file I/O.

## Out of scope / future work

- A dedicated `llm-theme` plugin if the contract surface grows.
- Per-component or per-tool-renderer color overrides.
- Migrating `claude-tui` to the same pattern.
- Per-field env-var mappings (`envVars` on `register`) — easy to add later if
  needed; none in v1.

## Risk

Low. kaizen-config is mature in this repo, the contract is unchanged, and the
biggest behavior delta (hot reload) is additive. Two invariants flip in
`llm-tui/CLAUDE.md`:

- "Theme is read-once" → no longer true; documented in the new invariant.
- Components that cached `themeService.current()` at mount time would miss
  updates. Audit during implementation; switch them to `state.theme` from the
  store snapshot.
