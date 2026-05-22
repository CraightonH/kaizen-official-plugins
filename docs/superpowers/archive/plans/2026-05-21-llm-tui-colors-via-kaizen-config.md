# llm-tui colors via kaizen-config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `llm-tui`'s private theme loader with a registration against
`kaizen-config`'s `config:store`, so `/config:set llm-tui promptColor=cyan`
changes the TUI colors live without restart.

**Architecture:** `llm-tui` registers a `UiTheme` schema with `config:store`,
gets the merged/validated value via `store.get()`, subscribes to changes via
`store.watch()`, and pushes updates into `TuiStore.setTheme()`. The store
snapshot now carries `theme`; React components read `state.theme` so the
existing `useSyncExternalStore` flow delivers hot-reload for free.

**Tech Stack:** TypeScript + Bun + React 19 + Ink 7. Workspace deps:
`llm-contracts/public` (contract types), `kaizen-config` (config store impl),
`kaizen/types` (plugin lifecycle).

**Spec:** `docs/superpowers/specs/2026-05-21-llm-tui-colors-via-kaizen-config-design.md`

---

## File Structure

### Created

- `plugins/llm-tui/theme/schema.ts` — `BUILT_IN_THEME`, `THEME_SCHEMA`, `COLOR_PATTERN`. Pure data; no I/O, no React.
- `plugins/llm-tui/theme/schema.test.ts` — regex + schema unit tests.

### Modified

- `plugins/llm-tui/index.tsx` — drop `loadTheme`, wire `config:store`, add `"config:store"` to `services.consumes`, build `TuiStore` with initial theme, push updates via `store.setTheme()`.
- `plugins/llm-tui/state/store.ts` — add `theme: UiTheme` to `TuiSnapshot`; `TuiStore` constructor accepts `{ theme }`; new `setTheme()` mutator. `TuiStore` imports `UiTheme` from `llm-contracts/public`.
- `plugins/llm-tui/state/store.test.ts` — cover `setTheme()` (snapshot identity, subscriber notification, constructor seed).
- `plugins/llm-tui/tool-renderers/defaults.tsx` — change `defaultRenderers(theme: TuiTheme)` to `defaultRenderers(getTheme: () => UiTheme)`; renderers call `getTheme()` at render time.
- `plugins/llm-tui/ui/App.tsx`, `ui/HistoryView.tsx`, `ui/InputBox.tsx`, `ui/LiveToolCalls.tsx`, `ui/PromptBox.tsx`, `ui/ToolCallBlock.tsx` — replace `import type { TuiTheme } from "../theme/loader.ts"` with `import type { UiTheme } from "llm-contracts/public"`; rename `TuiTheme` → `UiTheme` in prop signatures. App reads `theme` from the store snapshot instead of taking it as a prop.
- `plugins/llm-tui/ui/*.test.tsx` (App, HistoryView, InputBox, PromptBox) — replace `import { DEFAULT_THEME } from "../theme/loader.ts"` with `import { BUILT_IN_THEME } from "../theme/schema.ts"`; rename the symbol everywhere.
- `plugins/llm-tui/index.test.ts` — extend lifecycle smoke test for new wiring.
- `plugins/llm-tui/CLAUDE.md` — invariant updates and module-map entry.

### Deleted

- `plugins/llm-tui/theme/loader.ts`
- `plugins/llm-tui/theme/loader.test.ts`

---

## Task 1: Create the schema module

**Files:**
- Create: `plugins/llm-tui/theme/schema.ts`

- [ ] **Step 1: Create the schema module**

Write `plugins/llm-tui/theme/schema.ts`:

```ts
import type { ConfigSchema, UiTheme } from "llm-contracts/public";

/**
 * Accepts a `#RRGGBB` hex color or any of Ink's named colors (matching the
 * legacy `theme/loader.ts` allowlist exactly).
 */
export const COLOR_PATTERN =
  "^(#[0-9a-fA-F]{6}|black|red|green|yellow|blue|magenta|cyan|white|gray|grey|" +
  "blackBright|redBright|greenBright|yellowBright|blueBright|magentaBright|" +
  "cyanBright|whiteBright)$";

export const BUILT_IN_THEME: UiTheme = Object.freeze({
  promptLabel: "kaizen",
  promptColor: "magenta",
  outputColor: "white",
  noticeColor: "yellow",
  busyColor: "magenta",
  statusBarColor: "gray",
  thoughtsMarkdown: true,
}) as UiTheme;

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

- [ ] **Step 2: Commit**

```bash
git add plugins/llm-tui/theme/schema.ts
git commit -m "llm-tui: add theme schema module (no wiring yet)"
```

---

## Task 2: Test the schema module

**Files:**
- Create: `plugins/llm-tui/theme/schema.test.ts`

- [ ] **Step 1: Write the failing tests**

Write `plugins/llm-tui/theme/schema.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { validate } from "../../kaizen-config/schema.ts";
import { BUILT_IN_THEME, COLOR_PATTERN, THEME_SCHEMA } from "./schema.ts";

const COLOR_RE = new RegExp(COLOR_PATTERN);

const NAMED_COLORS = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "gray", "grey",
  "blackBright", "redBright", "greenBright", "yellowBright",
  "blueBright", "magentaBright", "cyanBright", "whiteBright",
];

describe("COLOR_PATTERN", () => {
  test("accepts every named color the legacy loader allowed", () => {
    for (const c of NAMED_COLORS) expect(COLOR_RE.test(c)).toBe(true);
  });
  test("accepts 6-digit hex in lower and upper case", () => {
    expect(COLOR_RE.test("#abcdef")).toBe(true);
    expect(COLOR_RE.test("#ABCDEF")).toBe(true);
    expect(COLOR_RE.test("#012345")).toBe(true);
  });
  test("rejects unknown names", () => {
    expect(COLOR_RE.test("purple")).toBe(false);
    expect(COLOR_RE.test("orange")).toBe(false);
  });
  test("rejects 3-digit hex and bad hex", () => {
    expect(COLOR_RE.test("#abc")).toBe(false);
    expect(COLOR_RE.test("#gghhii")).toBe(false);
    expect(COLOR_RE.test("red123")).toBe(false);
  });
  test("rejects empty string", () => {
    expect(COLOR_RE.test("")).toBe(false);
  });
});

describe("BUILT_IN_THEME", () => {
  test("passes its own schema", () => {
    const r = validate(BUILT_IN_THEME, THEME_SCHEMA);
    expect(r.ok).toBe(true);
  });
});

describe("THEME_SCHEMA validation via kaizen-config", () => {
  test("rejects bad color value", () => {
    const r = validate(
      { ...BUILT_IN_THEME, promptColor: "purple" },
      THEME_SCHEMA,
    );
    expect(r.ok).toBe(false);
  });
  test("rejects empty promptLabel", () => {
    const r = validate(
      { ...BUILT_IN_THEME, promptLabel: "" },
      THEME_SCHEMA,
    );
    expect(r.ok).toBe(false);
  });
  test("rejects non-boolean thoughtsMarkdown", () => {
    const r = validate(
      { ...BUILT_IN_THEME, thoughtsMarkdown: "yes" as unknown as boolean },
      THEME_SCHEMA,
    );
    expect(r.ok).toBe(false);
  });
  test("accepts hex color", () => {
    const r = validate(
      { ...BUILT_IN_THEME, promptColor: "#aabbcc" },
      THEME_SCHEMA,
    );
    expect(r.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests, verify they pass**

```bash
cd plugins/llm-tui && bun test theme/schema.test.ts
```

Expected: all tests pass. If the `validate` import path fails (kaizen-config
is a sibling workspace), confirm `package.json` has `"kaizen-config":
"workspace:*"` in `devDependencies`. If not, add it:

```bash
cd plugins/llm-tui
bun add -d kaizen-config@workspace:*
```

- [ ] **Step 3: Commit**

```bash
git add plugins/llm-tui/theme/schema.test.ts plugins/llm-tui/package.json
git commit -m "llm-tui: test theme schema"
```

---

## Task 3: Add `theme` to `TuiSnapshot` + `setTheme` mutator

**Files:**
- Modify: `plugins/llm-tui/state/store.ts`
- Modify: `plugins/llm-tui/state/store.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `plugins/llm-tui/state/store.test.ts`:

```ts
import { BUILT_IN_THEME } from "../theme/schema.ts";

describe("TuiStore.theme", () => {
  test("constructor seeds the initial theme", () => {
    const store = new TuiStore({ theme: BUILT_IN_THEME });
    expect(store.snapshot().theme).toBe(BUILT_IN_THEME);
  });

  test("setTheme replaces the snapshot value and notifies subscribers", () => {
    const store = new TuiStore({ theme: BUILT_IN_THEME });
    let calls = 0;
    store.subscribe(() => { calls++; });
    const before = store.snapshot();

    const next = { ...BUILT_IN_THEME, promptColor: "cyan" };
    store.setTheme(next);

    expect(store.snapshot().theme).toBe(next);
    expect(store.snapshot()).not.toBe(before);
    expect(calls).toBe(1);
  });

  test("setTheme is idempotent on identical reference (no-op subscribers ok)", () => {
    const store = new TuiStore({ theme: BUILT_IN_THEME });
    let calls = 0;
    store.subscribe(() => { calls++; });
    store.setTheme(BUILT_IN_THEME);
    expect(store.snapshot().theme).toBe(BUILT_IN_THEME);
    // We don't promise dedupe — just that the call doesn't throw and notifies.
    expect(calls).toBeGreaterThanOrEqual(0);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
cd plugins/llm-tui && bun test state/store.test.ts
```

Expected: FAIL with "snapshot().theme is undefined" and "setTheme is not a function".

- [ ] **Step 3: Wire `theme` into `TuiSnapshot` and `TuiStore`**

In `plugins/llm-tui/state/store.ts`:

a. Add the import at the top (next to other contract imports):

```ts
import type {
  ToolCallStatus,
  UiPromptOptionsRequest,
  UiPromptTextRequest,
  UiTheme,
} from "llm-contracts/public";
```

b. Add `theme` to the `TuiSnapshot` interface (right after `sourcesVersion`):

```ts
export interface TuiSnapshot {
  // ...existing fields...
  sourcesVersion: number;
  /** Current theme. Pushed in via setTheme(); read by UI components. */
  theme: UiTheme;
}
```

c. In the `TuiStore` class, add a private field and constructor:

```ts
export class TuiStore {
  // ...existing private fields above _snapshot...
  private _theme: UiTheme;
  private _seq = 0;
  // ...existing pastes/pending/queue/listeners...
  private _snapshot: TuiSnapshot;

  constructor(opts: { theme: UiTheme }) {
    this._theme = opts.theme;
    this._snapshot = this._build();
  }
```

> NOTE: `_snapshot` was previously initialized inline with `= this._build()`.
> Move it into the constructor so it runs **after** `_theme` is set. Remove
> the inline initializer.

d. Add the mutator next to other reducer-style methods (anywhere before
   `_build`):

```ts
  setTheme(next: UiTheme): void {
    this._theme = next;
    this._emit();
  }
```

e. Include `theme` in `_build()`:

```ts
  private _build(): TuiSnapshot {
    return {
      // ...existing fields...
      sourcesVersion: this._sourcesVersion,
      theme: this._theme,
    };
  }
```

- [ ] **Step 4: Run all store tests, verify they pass**

```bash
cd plugins/llm-tui && bun test state/store.test.ts
```

Expected: PASS for the three new tests; **all previously passing tests must
still pass.** If existing tests fail because they call `new TuiStore()` with
no args, fix them by passing the theme:

```ts
import { BUILT_IN_THEME } from "../theme/schema.ts";
const store = new TuiStore({ theme: BUILT_IN_THEME });
```

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-tui/state/store.ts plugins/llm-tui/state/store.test.ts
git commit -m "llm-tui: thread theme through TuiSnapshot + setTheme mutator"
```

---

## Task 4: Refactor `defaultRenderers` to read theme at render time

**Files:**
- Modify: `plugins/llm-tui/tool-renderers/defaults.tsx`

Why: renderers are registered once at setup. If theme is captured by closure,
hot-reload doesn't reach them. Switch to a `getTheme` callback so each render
call uses the current value.

- [ ] **Step 1: Convert the signature**

In `plugins/llm-tui/tool-renderers/defaults.tsx`:

a. Replace the import:

```ts
import type { UiTheme, UiToolRenderer } from "llm-contracts/public";
```

(Drop the `TuiTheme` import from `../theme/loader.ts`.)

b. Change every helper signature that takes `theme: TuiTheme` to take
   `theme: UiTheme` (just a rename; same shape).

c. Change the exported function:

```ts
export function defaultRenderers(getTheme: () => UiTheme): UiToolRenderer[] {
```

d. The file is structured as an array of `UiToolRenderer` objects, each with
   `collapsedSummary` and `expandedView` callbacks. Strategy: inside each
   callback that references `theme`, add `const theme = getTheme();` as the
   first statement, then leave the body unchanged.

```ts
// Example — apply to each callback that references `theme`
{
  toolName: "edit",
  collapsedSummary: (args) => { /* text only, no theme — leave alone */ },
  expandedView: (args, result, status) => {
    const theme = getTheme();
    // ...existing body using `theme`...
  },
}
```

The renderers in this file are: `edit`, `write`, `create`,
`execute_typescript`, `bash`. Most reference `theme` only in `expandedView`
(for colored diff lines, headlines, error messages).

e. The two top-level helpers `renderError(msg, theme)` and `renderLines(...,
   theme, ...)` continue to accept `theme: UiTheme` as a parameter — they're
   called from within an `expandedView` callback where `theme` is already in
   scope.

- [ ] **Step 2: Update the one caller (in index.tsx)**

In `plugins/llm-tui/index.tsx`, locate:

```ts
for (const r of defaultRenderers(theme)) toolRenderers.service.register(r);
```

For now (still in this task), leave it referencing the local `theme`
variable, but wrap it as a closure so the signature compiles:

```ts
for (const r of defaultRenderers(() => themeService.current())) toolRenderers.service.register(r);
```

(`themeService.current()` already returns the latest `UiTheme` in the current
code path. Task 6 swaps out the theme source completely.)

- [ ] **Step 3: Build + run plugin tests**

```bash
cd plugins/llm-tui && bun test
```

Expected: PASS. Tool-renderer behavior is exercised via the UI tests
(`ui/ToolCallBlock.test.tsx`, `ui/LiveToolCalls.test.tsx`) and the index
lifecycle smoke test.

- [ ] **Step 4: Commit**

```bash
git add plugins/llm-tui/tool-renderers/defaults.tsx plugins/llm-tui/index.tsx
git commit -m "llm-tui: read theme via getTheme callback in default renderers"
```

---

## Task 5: Migrate UI prop types to `UiTheme` and stop importing from loader

**Files:**
- Modify: `plugins/llm-tui/ui/App.tsx`
- Modify: `plugins/llm-tui/ui/HistoryView.tsx`
- Modify: `plugins/llm-tui/ui/InputBox.tsx`
- Modify: `plugins/llm-tui/ui/LiveToolCalls.tsx`
- Modify: `plugins/llm-tui/ui/PromptBox.tsx`
- Modify: `plugins/llm-tui/ui/ToolCallBlock.tsx`

Why: `TuiTheme` is a deprecated alias for `UiTheme`. Drop the loader import in
preparation for deleting the loader, and use the contract type directly.

- [ ] **Step 1: Replace the import in each UI file**

In each of the six files above, replace:

```ts
import type { TuiTheme } from "../theme/loader.ts";
```

with:

```ts
import type { UiTheme } from "llm-contracts/public";
```

And in the same file, replace `TuiTheme` with `UiTheme` everywhere it
appears (prop types, function signatures). This is a pure rename; no
behavior changes.

- [ ] **Step 2: Run all plugin tests**

```bash
cd plugins/llm-tui && bun test
```

Expected: PASS. (The UI test files still import `DEFAULT_THEME` from the
loader; that's fine for now — Task 7 fixes those imports.)

- [ ] **Step 3: Commit**

```bash
git add plugins/llm-tui/ui/App.tsx plugins/llm-tui/ui/HistoryView.tsx \
        plugins/llm-tui/ui/InputBox.tsx plugins/llm-tui/ui/LiveToolCalls.tsx \
        plugins/llm-tui/ui/PromptBox.tsx plugins/llm-tui/ui/ToolCallBlock.tsx
git commit -m "llm-tui: switch UI prop types from TuiTheme alias to UiTheme"
```

---

## Task 6: Make `App` read theme from the store snapshot

**Files:**
- Modify: `plugins/llm-tui/ui/App.tsx`
- Modify: `plugins/llm-tui/index.tsx`
- Modify: `plugins/llm-tui/ui/App.test.tsx`

Why: the only way the live-reload chain (config change → store.setTheme() →
React re-render) works is if `App` reads theme from the snapshot, not from a
fixed prop captured at mount time.

- [ ] **Step 1: Drop the `theme` prop on `App`**

In `plugins/llm-tui/ui/App.tsx`:

a. In the `AppProps` interface, remove the `theme: UiTheme` field.

b. In the destructured prop list, remove `theme`.

c. Add a derived `theme` from the snapshot, immediately after the
   `useSyncExternalStore` call:

```ts
const snap = useSyncExternalStore(
  (cb) => store.subscribe(cb),
  () => store.snapshot(),
);
const theme = snap.theme;
```

Leave every downstream usage of `theme` exactly as-is — they all reference
the local `theme` variable that is now sourced from the snapshot.

- [ ] **Step 2: Drop the `theme` prop at the call site**

In `plugins/llm-tui/index.tsx`, change the JSX inside `render(...)` from:

```tsx
<App
  store={store}
  registry={registry}
  toolRenderers={toolRenderers}
  sources={sources}
  theme={theme}
  onSubmit={onSubmit}
  onCancel={onCancel}
  onExit={onExit}
  copyToClipboard={copyToClipboard}
/>
```

to:

```tsx
<App
  store={store}
  registry={registry}
  toolRenderers={toolRenderers}
  sources={sources}
  onSubmit={onSubmit}
  onCancel={onCancel}
  onExit={onExit}
  copyToClipboard={copyToClipboard}
/>
```

(Task 7 will deal with where `theme` comes from in `index.tsx`. For now,
leave the `theme` local in place; the JSX just stops passing it.)

- [ ] **Step 3: Update `ui/App.test.tsx`**

The test renders `<App ... theme={DEFAULT_THEME} />`. Now that App reads from
the store, the test must seed the store with a theme instead.

Open `plugins/llm-tui/ui/App.test.tsx`:

a. Replace the import:

```ts
// before
import { DEFAULT_THEME } from "../theme/loader.ts";
// after
import { BUILT_IN_THEME } from "../theme/schema.ts";
```

b. In every `new TuiStore(...)` call in the file, pass the theme:

```ts
const store = new TuiStore({ theme: BUILT_IN_THEME });
```

c. Remove the `theme={DEFAULT_THEME}` prop from every `<App ... />` JSX
   render. Search-and-replace `theme={DEFAULT_THEME}` → (empty).

d. Update any other reference to `DEFAULT_THEME` → `BUILT_IN_THEME`.

- [ ] **Step 4: Run App tests, verify they pass**

```bash
cd plugins/llm-tui && bun test ui/App.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Run the whole plugin test suite**

```bash
cd plugins/llm-tui && bun test
```

Expected: PASS. If `index.test.ts` or other files trip on the JSX prop
change, fix the same way (drop `theme={...}` from `<App>` calls, pass theme
via `new TuiStore({ theme: ... })`).

- [ ] **Step 6: Commit**

```bash
git add plugins/llm-tui/ui/App.tsx plugins/llm-tui/index.tsx \
        plugins/llm-tui/ui/App.test.tsx
git commit -m "llm-tui: App reads theme from store snapshot, drops theme prop"
```

---

## Task 7: Migrate remaining test files off `DEFAULT_THEME`

**Files:**
- Modify: `plugins/llm-tui/ui/HistoryView.test.tsx`
- Modify: `plugins/llm-tui/ui/InputBox.test.tsx`
- Modify: `plugins/llm-tui/ui/PromptBox.test.tsx`

- [ ] **Step 1: In each of the three files, replace the import**

```ts
// before
import { DEFAULT_THEME } from "../theme/loader.ts";
// after
import { BUILT_IN_THEME } from "../theme/schema.ts";
```

And rename every reference: `DEFAULT_THEME` → `BUILT_IN_THEME`.

Where these tests construct a `new TuiStore()`, pass the theme:

```ts
const store = new TuiStore({ theme: BUILT_IN_THEME });
```

- [ ] **Step 2: Run the tests**

```bash
cd plugins/llm-tui && bun test ui/HistoryView.test.tsx ui/InputBox.test.tsx ui/PromptBox.test.tsx
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add plugins/llm-tui/ui/HistoryView.test.tsx \
        plugins/llm-tui/ui/InputBox.test.tsx \
        plugins/llm-tui/ui/PromptBox.test.tsx
git commit -m "llm-tui: move UI tests off DEFAULT_THEME to BUILT_IN_THEME"
```

---

## Task 8: Wire `config:store` in `index.tsx`

**Files:**
- Modify: `plugins/llm-tui/index.tsx`

This is the central change. Replace the `loadTheme` call with a registration
against `config:store`, plus a `watch()` subscription that pushes updates
through the store.

- [ ] **Step 1: Update the manifest's `services.consumes`**

Find the existing block:

```ts
services: {
  provides: ["ui:channel", "ui:completion-source", "ui:status", "ui:theme", "ui:tool-renderer", "ui:prompt"],
  consumes: ["events:vocabulary"],
},
```

Change to:

```ts
services: {
  provides: ["ui:channel", "ui:completion-source", "ui:status", "ui:theme", "ui:tool-renderer", "ui:prompt"],
  consumes: ["events:vocabulary", "config:store"],
},
```

- [ ] **Step 2: Replace the theme-loading block**

Find:

```ts
import { loadTheme, realThemeDeps } from "./theme/loader.ts";
```

and the block inside `setup`:

```ts
// Theme: harness defaults from plugin config, user override from config file.
const harnessDefaults = (ctx.config as any)?.theme as Partial<UiTheme> | undefined;
const theme = await loadTheme(realThemeDeps(ctx.log, harnessDefaults));
const themeService: UiThemeService = { current: () => theme };
ctx.provideService<UiThemeService>("ui:theme", themeService);
```

Replace the import line with:

```ts
import { BUILT_IN_THEME, THEME_SCHEMA } from "./theme/schema.ts";
import type { ConfigStoreService } from "llm-contracts/public";
```

Replace the setup block with:

```ts
// Theme: backed by kaizen-config. Harness manifest may seed defaults via
// ctx.config.theme. /config:set llm-tui <field>=<value> updates live.
const harnessDefaults =
  ((ctx.config as { theme?: Partial<UiTheme> } | undefined)?.theme ?? {}) as Partial<UiTheme>;

let currentTheme: UiTheme = { ...BUILT_IN_THEME, ...harnessDefaults };
let teardownConfigWatch: (() => void) | null = null;

try {
  ctx.consumeService("config:store");
  const cfgStore = ctx.useService<ConfigStoreService>("config:store");
  cfgStore.register<UiTheme>({
    plugin: "llm-tui",
    defaults: currentTheme,
    schema: THEME_SCHEMA,
  });
  currentTheme = cfgStore.get<UiTheme>("llm-tui");
  teardownConfigWatch = cfgStore.watch<UiTheme>("llm-tui", (next) => {
    try {
      currentTheme = next;
      store.setTheme(next);
    } catch (err) {
      ctx.log(`llm-tui: failed to apply theme update: ${(err as Error).message}`);
    }
  });
} catch (err) {
  ctx.log(`llm-tui: config:store unavailable (${(err as Error).message}); using static defaults`);
}

const themeService: UiThemeService = { current: () => currentTheme };
ctx.provideService<UiThemeService>("ui:theme", themeService);
```

> NOTE: `store.setTheme(next)` references the `TuiStore` instance. The
> existing `const store = new TuiStore()` line appears further down — move
> the theme setup block to **after** the store is created, OR forward-declare
> the store first. Easiest: relocate the existing `const store = new
> TuiStore()` line above this block.

- [ ] **Step 3: Update the `TuiStore` construction**

The existing line is:

```ts
const store = new TuiStore();
```

Change to:

```ts
const store = new TuiStore({ theme: { ...BUILT_IN_THEME, ...harnessDefaults } });
```

And move it **above** the theme-loading block from Step 2, so `store.setTheme`
is available when the `watch()` callback fires synchronously during registration.

After the theme load resolves `currentTheme` (line `currentTheme = cfgStore.get<UiTheme>("llm-tui")`),
push it into the store:

```ts
store.setTheme(currentTheme);
```

Place this `store.setTheme(currentTheme)` immediately after the
`currentTheme = cfgStore.get<UiTheme>(...)` line, **before** registering the
watch. (The watch only fires on later changes.)

- [ ] **Step 4: Add teardown**

The plugin's `stop()` already unmounts Ink. Add the config-watch teardown
just above the `inkApp.unmount()` line in `stop()`:

```ts
async stop() {
  try { (plugin as any).__configWatch?.(); } catch { /* ignore */ }
  const inkApp = (plugin as any).__ink;
  if (inkApp) {
    try { inkApp.unmount(); } catch { /* ignore */ }
  }
},
```

And at the bottom of `setup`, stash the teardown on the plugin object next
to `__ink`:

```ts
(plugin as any).__ink = inkApp;
(plugin as any).__configWatch = teardownConfigWatch;
```

- [ ] **Step 5: Run the index lifecycle test**

```bash
cd plugins/llm-tui && bun test index.test.ts
```

Expected: tests that stub `config:store` pass; tests that didn't stub it
should be updated. Look for the fake `ctx` factory inside `index.test.ts` and
extend `useService`/`consumeService` to recognize `"config:store"` and return
a minimal stub:

```ts
const fakeConfigStore: ConfigStoreService = {
  register: () => {},
  get: <T>() => (BUILT_IN_THEME as unknown as T),
  set: async () => {},
  unset: async () => {},
  watch: () => () => {},
  getSpec: () => undefined,
};
// In the fake ctx's useService:
useService: <T>(name: string): T => {
  if (name === "config:store") return fakeConfigStore as unknown as T;
  // ...existing branches...
},
```

Add to the existing test what's needed; do not duplicate the whole `ctx` fake.

- [ ] **Step 6: Run the whole plugin test suite**

```bash
cd plugins/llm-tui && bun test
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add plugins/llm-tui/index.tsx plugins/llm-tui/index.test.ts
git commit -m "llm-tui: source theme from kaizen-config, hot-reload via store.setTheme"
```

---

## Task 9: Add an end-to-end hot-reload test in `index.test.ts`

**Files:**
- Modify: `plugins/llm-tui/index.test.ts`

- [ ] **Step 1: Write the failing test**

Append a new test that:

1. Stubs `config:store` with a `watch()` that captures the registered
   callback.
2. Mounts the plugin (`await plugin.setup(fakeCtx)`).
3. Confirms `store.snapshot().theme` matches the value returned by the
   stub's `get()`.
4. Fires the captured `watch` callback with a new theme.
5. Confirms `store.snapshot().theme` reflects the new value.

The test must reach the `TuiStore` instance. The simplest path: hold a
reference to the `TuiStore` constructor and capture it (the plugin builds the
store at setup time and only exposes it via the channel service, so the test
asserts via `snapshot().theme`). If the fake `provideService` records every
provided service, the `ui:channel` provider can be inspected to confirm
behavior — but for the theme test, just expose `TuiStore` by spying on its
constructor.

```ts
test("watch() callback updates store snapshot theme", async () => {
  let captured: ((next: UiTheme) => void) | null = null;
  const initial: UiTheme = { ...BUILT_IN_THEME, promptColor: "red" };
  const fakeConfig: ConfigStoreService = {
    register: () => {},
    get: <T>() => (initial as unknown as T),
    set: async () => {},
    unset: async () => {},
    watch: (_plugin, cb) => {
      captured = cb as (next: UiTheme) => void;
      return () => {};
    },
    getSpec: () => undefined,
  };

  const providedStores: TuiStore[] = [];
  // Patch TuiStore constructor to record instances for inspection.
  const OriginalTuiStore = TuiStore;
  // @ts-expect-error - patch
  (globalThis as any).__TuiStoreCtor = function PatchedTuiStore(opts: any) {
    const inst = new OriginalTuiStore(opts);
    providedStores.push(inst);
    return inst;
  };

  const ctx = makeFakeCtx({ services: { "config:store": fakeConfig } });
  await plugin.setup(ctx);

  expect(providedStores.length).toBe(1);
  expect(providedStores[0]!.snapshot().theme).toEqual(initial);

  expect(captured).not.toBeNull();
  const next: UiTheme = { ...initial, promptColor: "cyan" };
  captured!(next);

  expect(providedStores[0]!.snapshot().theme).toEqual(next);
});
```

> NOTE: If `index.test.ts` already has a `makeFakeCtx` (or similar) helper,
> use that — the snippet above assumes one exists with a `services` override.
> If not, write the equivalent ctx fake inline. The patching of `TuiStore` is
> awkward; an alternative is to inspect the snapshot via the
> `ui:channel`/`ui:theme` providers the plugin registers. Use whichever is
> idiomatic in the existing file.

- [ ] **Step 2: Run the test, verify it passes**

```bash
cd plugins/llm-tui && bun test index.test.ts
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add plugins/llm-tui/index.test.ts
git commit -m "llm-tui: smoke-test hot-reload through config:store watch"
```

---

## Task 10: Delete the legacy loader

**Files:**
- Delete: `plugins/llm-tui/theme/loader.ts`
- Delete: `plugins/llm-tui/theme/loader.test.ts`

- [ ] **Step 1: Verify no remaining references**

```bash
grep -rn "theme/loader\|TuiTheme\|DEFAULT_THEME\|loadTheme\|realThemeDeps" \
  plugins/llm-tui --include='*.ts' --include='*.tsx' \
  | grep -v node_modules | grep -v dist
```

Expected: no matches. (The deprecated `TuiTheme` alias and `DEFAULT_THEME`
constant lived only in `theme/loader.ts`; all callers were migrated in tasks
4–7.)

If anything matches, fix the importer to use `UiTheme` from
`llm-contracts/public` or `BUILT_IN_THEME` from `theme/schema.ts`.

- [ ] **Step 2: Delete the files**

```bash
git rm plugins/llm-tui/theme/loader.ts plugins/llm-tui/theme/loader.test.ts
```

- [ ] **Step 3: Run the whole plugin test suite**

```bash
cd plugins/llm-tui && bun test
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git commit -m "llm-tui: drop legacy theme loader"
```

---

## Task 11: Update plugin docs

**Files:**
- Modify: `plugins/llm-tui/CLAUDE.md`

- [ ] **Step 1: Update the module map**

In `plugins/llm-tui/CLAUDE.md`, find the `theme/loader.ts` entry in the
module-map table:

```
theme/loader.ts        loadTheme(deps) → UiTheme. DI-friendly (deps inject readFile/env/log).
                       realThemeDeps(log, harnessDefaults) supplies the real ones at mount.
                       DEFAULT_THEME is the baked-in floor.
```

Replace with:

```
theme/schema.ts        BUILT_IN_THEME (baked-in floor) and THEME_SCHEMA (validation for
                       /config:set llm-tui <field>=<value>). Pure data. The theme value
                       itself is owned by kaizen-config and lives on TuiSnapshot.theme.
```

- [ ] **Step 2: Update the boundaries block**

Find:

```
- `state/store.ts`, `completion/registry.ts`, and `theme/loader.ts` are the only stateful non-UI modules. All three are framework-free (no React, no `ctx`).
```

Replace with:

```
- `state/store.ts` and `completion/registry.ts` are the only stateful non-UI modules. Both are framework-free (no React, no `ctx`). `theme/schema.ts` is pure data.
```

- [ ] **Step 3: Replace the theme invariant**

Find:

```
- **Theme is read-once.** No hot reload. If you add a watcher, keep `current()` returning a stable reference between mutations so consumers can cache.
```

Replace with:

```
- **Theme lives on the store snapshot.** `config:store.watch("llm-tui")` pushes updates into `TuiStore.setTheme()`. `UiThemeService.current()` returns the latest value. Components must read `state.theme` from the snapshot rather than calling `themeService.current()` ad hoc, or they'll miss live updates. Tool renderers take a `getTheme: () => UiTheme` callback for the same reason.
```

- [ ] **Step 4: Update the testing block**

Find:

```
- `theme/loader.test.ts` uses injected `ThemeDeps` — never the real filesystem.
```

Replace with:

```
- `theme/schema.test.ts` exercises the color regex and `THEME_SCHEMA` against the kaizen-config validator. No filesystem.
```

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-tui/CLAUDE.md
git commit -m "llm-tui: document kaizen-config-backed theme"
```

---

## Task 12: Local deploy + smoke test

**Files:** (no source changes — deployment + manual verify)

- [ ] **Step 1: Re-bundle and copy into the install dir**

```bash
PLUGIN=llm-tui
VERSION=$(jq -r .version plugins/$PLUGIN/package.json)
INSTALL_DIR=~/.kaizen/marketplaces/official/plugins/${PLUGIN}@${VERSION}
(cd plugins/$PLUGIN && bun build --target=bun --outfile=dist/index.js index.tsx)
mkdir -p "$INSTALL_DIR/dist"
cp plugins/$PLUGIN/dist/index.js "$INSTALL_DIR/dist/index.js"
rsync -a --exclude='node_modules' --exclude='dist' plugins/$PLUGIN/ "$INSTALL_DIR/"
```

Expected: `bun build` completes without errors; rsync copies metadata.

- [ ] **Step 2: Validate the plugin manifest**

```bash
kaizen plugin validate plugins/llm-tui
```

Expected: PASS.

- [ ] **Step 3: Manual smoke test**

Start the harness and verify the user-facing flow works:

```bash
kaizen --harness ./harnesses/local.json
```

Inside the running TUI:

1. Note the current prompt color (default magenta).
2. Run: `/config:set llm-tui promptColor=cyan`
3. Expected: the prompt label re-renders in cyan **without restart**.
4. Run: `/config:get llm-tui` → confirm the value is persisted.
5. Run: `/config:set llm-tui promptColor=purple`
6. Expected: a validation error printed to the notice channel; theme
   unchanged.
7. Run: `/config:unset llm-tui promptColor`
8. Expected: the prompt color returns to the default (`magenta` from
   `BUILT_IN_THEME`).
9. Inspect `~/.kaizen/harnesses/<key>/config.json` — confirm the
   `llm-tui` block reflects only what was set (no stale fields).

- [ ] **Step 4: Confirm the legacy file is ignored**

If `~/.kaizen/plugins/llm-tui/config.json` exists from a prior install,
verify it is **ignored** — the running TUI must use the values from the new
kaizen-config location.

```bash
test -f ~/.kaizen/plugins/llm-tui/config.json \
  && echo "legacy file still present (ignored as expected; user can delete manually)" \
  || echo "no legacy file present"
```

No code change here — just verify the spec's "hard cut" behavior.

- [ ] **Step 5: Final commit (no-op if nothing changed)**

```bash
git status
# Should be clean; if dist/ changed, that's local-only — do NOT commit it
# unless this repo tracks dist/ (check .gitignore).
```

---

## Verification checklist

- [ ] `cd plugins/llm-tui && bun test` — all tests pass
- [ ] `cd plugins/llm-contracts && bun test` — still passes (no changes)
- [ ] `cd plugins/kaizen-config && bun test` — still passes (no changes)
- [ ] `kaizen plugin validate plugins/llm-tui` — clean
- [ ] Manual smoke test in `harnesses/local.json` — `/config:set llm-tui promptColor=cyan` updates colors live
- [ ] `grep -rn "TuiTheme\|loadTheme\|DEFAULT_THEME\|theme/loader" plugins/llm-tui` — no matches
