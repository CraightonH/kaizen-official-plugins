# Slash-command argument completion — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the inline completion popup argument-aware so `/config:set`, `/config:get`, and `/config:unset` complete plugin names, schema keys (with value shortcuts for booleans/enums), and `--project`/`--reveal` flags.

**Architecture:** Two additive contract extensions in `llm-contracts` (`CompletionSource.match` predicate; `SlashCommandManifest.arguments`/`flags`). `llm-tui` widens popup state to carry a `sourceId`, adds a second activation pass that consults `match`-bearing sources, and adds `queryBySource`. `llm-slash-commands` registers one match-based source that parses the line, determines the active slot, and dispatches to the manifest's `complete` function. `kaizen-config` declares slot definitions and a shared `slash-completions.ts` helper for all three commands.

**Tech Stack:** TypeScript, Bun, React/Ink (for `llm-tui`), `bun:test` with `ink-testing-library`.

**Reference docs:**
- Spec: `docs/superpowers/specs/2026-05-21-slash-arg-completion-design.md`
- Architecture: `docs/PLUGIN_ARCHITECTURE.md`
- Repo conventions: root `CLAUDE.md` (commits straight to `main`, no `Co-Authored-By`, skip `document-and-commit`)
- Per-plugin: each plugin's own `CLAUDE.md` documents its module map and local-deploy recipe

**Commit policy:** straight to `main`. Commit at the end of each task. Use `git commit -m "<message>"` with no `Co-Authored-By` line.

**Local-deploy policy:** Each plugin task ends with a deploy step that builds `dist/index.js` and rsyncs into `~/.kaizen/marketplaces/official/plugins/<plugin>@<version>/`. `llm-contracts` MUST be deployed before any plugin that depends on its new types.

---

## Phase 1 — `llm-contracts`: additive contract changes

### Task 1: Add `match` and `CompletionContext` to `CompletionSource`

**Files:**
- Modify: `plugins/llm-contracts/contracts/ui-completion.ts`

- [ ] **Step 1: Edit the contract**

Replace the file body with:

```ts
export const CONTRACT_ID = "ui:completion-source";
export const DESCRIPTION = "Registry of completion sources for input popups.";

export interface CompletionItem {
  label: string;
  detail?: string;
  insertText: string;
  sortWeight?: number;
}

export interface CompletionContext {
  line: string;
  cursor: number;
}

export interface CompletionSource {
  id: string;
  /**
   * Single-char activation. Set this OR `match`, not both. When set, the
   * popup opens on this char at a word-start outside quotes/backticks.
   */
  trigger?: string;
  /**
   * Predicate-based activation. Set this OR `trigger`, not both. The TUI
   * calls `match(line, cursor)` on every line/cursor change; a non-null
   * return opens (or keeps open) a popup pinned to this source.
   */
  match?: (line: string, cursor: number) => { triggerPos: number; query: string } | null;
  list(query: string, ctx?: CompletionContext): CompletionItem[] | Promise<CompletionItem[]>;
}

export interface UiCompletionService {
  register(source: CompletionSource): () => void;
}
```

- [ ] **Step 2: Re-export `CompletionContext` from `public.ts`**

Open `plugins/llm-contracts/public.ts` and update the ui-completion re-export to include `CompletionContext`:

```ts
export type { UiCompletionService, CompletionItem, CompletionSource, CompletionContext } from "./contracts/ui-completion";
```

- [ ] **Step 3: Run tests**

```bash
cd plugins/llm-contracts && bun test
```

Expected: all existing tests pass (no behavior change).

- [ ] **Step 4: Commit**

```bash
git add plugins/llm-contracts/contracts/ui-completion.ts plugins/llm-contracts/public.ts
git commit -m "llm-contracts: extend CompletionSource with match predicate"
```

---

### Task 2: Add `arguments` and `flags` to `SlashCommandManifest`

**Files:**
- Modify: `plugins/llm-contracts/contracts/slash-registry.ts`

- [ ] **Step 1: Edit the manifest**

In `plugins/llm-contracts/contracts/slash-registry.ts`, add the new types and append to the manifest:

```ts
import type { CompletionItem } from "./ui-completion";

export interface ArgSlot {
  name: string;
  description?: string;
  complete?: (prev: string[], query: string) =>
    Promise<CompletionItem[]> | CompletionItem[];
}

export interface SlashCommandFlag {
  name: string;            // e.g. "--project"
  description?: string;
}

export interface SlashCommandManifest {
  name: string;
  description: string;
  usage?: string;
  source: "builtin" | "plugin" | "file";
  filePath?: string;
  arguments?: ArgSlot[];
  flags?: SlashCommandFlag[];
}
```

(Replace the existing `SlashCommandManifest` block; keep the rest of the file unchanged.)

- [ ] **Step 2: Re-export new types from `public.ts`**

Open `plugins/llm-contracts/public.ts` and find the slash-registry re-export line. Update it to include `ArgSlot` and `SlashCommandFlag`:

```ts
export type {
  SlashCommandContext,
  SlashCommandHandler,
  SlashCommandManifest,
  SlashPrintOptions,
  SlashRegistryEntry,
  RegistryEntry,
  SlashRegistryService,
  ArgSlot,
  SlashCommandFlag,
} from "./contracts/slash-registry";
```

(If the existing re-export uses a different shape, just add `ArgSlot` and `SlashCommandFlag` to the type list — don't rewrite unrelated exports.)

- [ ] **Step 3: Run tests**

```bash
cd plugins/llm-contracts && bun test
```

Expected: all existing tests pass.

- [ ] **Step 4: Commit**

```bash
git add plugins/llm-contracts/contracts/slash-registry.ts plugins/llm-contracts/public.ts
git commit -m "llm-contracts: add ArgSlot and flags to SlashCommandManifest"
```

---

### Task 3: Deploy `llm-contracts`

- [ ] **Step 1: Build and sync**

```bash
PLUGIN=llm-contracts
VERSION=$(jq -r .version plugins/$PLUGIN/package.json)
INSTALL_DIR=~/.kaizen/marketplaces/official/plugins/${PLUGIN}@${VERSION}
(cd plugins/$PLUGIN && bun build --target=bun --outfile=dist/index.js index.ts)
mkdir -p "$INSTALL_DIR/dist"
cp plugins/$PLUGIN/dist/index.js "$INSTALL_DIR/dist/index.js"
rsync -a --exclude='node_modules' --exclude='dist' plugins/$PLUGIN/ "$INSTALL_DIR/"
```

Expected: exits 0; no rsync errors.

- [ ] **Step 2: Commit any committed dist if the repo tracks it**

```bash
git status plugins/llm-contracts/dist
```

If `dist/index.js` is tracked and changed, `git add plugins/llm-contracts/dist/index.js && git commit -m "llm-contracts: rebuild dist"`. If untracked (in `.gitignore`), skip.

---

## Phase 2 — `llm-tui`: match-based popup sessions

### Task 4: Widen `PopupState` with `sourceId`

**Files:**
- Modify: `plugins/llm-tui/state/store.ts`
- Modify: `plugins/llm-tui/state/store.test.ts`

- [ ] **Step 1: Write failing test for new popup shape**

Open `plugins/llm-tui/state/store.test.ts` and add a test (place it next to other popup tests; search for `openPopup` to find them):

```ts
it("openPopup records sourceId and trigger for char sources", () => {
  const s = new TuiStore();
  s.openPopup({ sourceId: "src1", trigger: "/", query: "", anchor: 3 });
  const p = s.snapshot().popup;
  expect(p?.sourceId).toBe("src1");
  expect(p?.trigger).toBe("/");
  expect(p?.anchor).toBe(3);
});

it("openPopup records sourceId only for match-based sources", () => {
  const s = new TuiStore();
  s.openPopup({ sourceId: "args", query: "", anchor: 12 });
  const p = s.snapshot().popup;
  expect(p?.sourceId).toBe("args");
  expect(p?.trigger).toBeUndefined();
  expect(p?.anchor).toBe(12);
});
```

- [ ] **Step 2: Run test to verify failure**

```bash
cd plugins/llm-tui && bun test state/store.test.ts
```

Expected: TypeScript / runtime error — `openPopup` signature doesn't accept an object.

- [ ] **Step 3: Update `PopupState` and `openPopup`**

In `plugins/llm-tui/state/store.ts`:

a) Replace the `PopupState` interface:

```ts
export interface PopupState {
  /** Source id this popup is pinned to. */
  sourceId: string;
  /**
   * Single-char trigger when the popup was opened by a char source.
   * Undefined for match-based sources.
   */
  trigger?: string;
  query: string;
  items: CompletionItem[];
  selectedIndex: number;
  /**
   * Character index in the input value where the completed token starts.
   * For char-triggered popups, this is the position of the trigger char.
   * For match-based popups, this is wherever the source decided.
   * Used by InputBox to compute the substring to replace on accept.
   */
  anchor: number;
}
```

b) Update `openPopup` signature:

```ts
openPopup(args: { sourceId: string; trigger?: string; query: string; anchor: number }): void {
  this._popup = {
    sourceId: args.sourceId,
    trigger: args.trigger,
    query: args.query,
    items: [],
    selectedIndex: 0,
    anchor: args.anchor,
  };
  this._emit();
}
```

c) Update any other internal references to `popup.triggerPos` (in `store.ts` only) to `popup.anchor`. There should be none outside `openPopup`.

- [ ] **Step 4: Update existing store tests that use the old shape**

Search the test file for the old call signature and old field names:

```bash
cd plugins/llm-tui && grep -n "openPopup\|triggerPos" state/store.test.ts
```

For each call site, replace `s.openPopup("/", "", 3)` with `s.openPopup({ sourceId: "stub", trigger: "/", query: "", anchor: 3 })`. Replace any `popup.triggerPos` reads with `popup.anchor`. Pick `sourceId: "stub"` for tests that don't care about it.

- [ ] **Step 5: Run tests**

```bash
cd plugins/llm-tui && bun test state/store.test.ts
```

Expected: all pass, including the two new tests.

- [ ] **Step 6: Commit**

```bash
git add plugins/llm-tui/state/store.ts plugins/llm-tui/state/store.test.ts
git commit -m "llm-tui: widen PopupState with sourceId and anchor"
```

---

### Task 5: Update `InputBox` for new popup shape (no new activation yet)

**Files:**
- Modify: `plugins/llm-tui/ui/InputBox.tsx`
- Modify: `plugins/llm-tui/ui/InputBox.test.tsx`

This task adapts the existing `/` trigger path to the new shape — no new behavior yet.

- [ ] **Step 1: Update `InputBox.tsx` references**

Find each occurrence of `popup.triggerPos` in `plugins/llm-tui/ui/InputBox.tsx` and rename to `popup.anchor`. Find the single existing `store.openPopup(ch, "", triggerPos)` call and change it to:

```ts
store.openPopup({ sourceId: source.id, trigger: ch, query: "", anchor: triggerPos });
```

To get `source.id` you need access to the matching source. The simplest path: change the `triggers` set into a `Map<string, CompletionSource>` keyed by trigger char (or store the source id alongside the trigger). See Task 6 — for now, you can pass `sourceId: "char-trigger"` as a placeholder; Task 7 introduces the proper plumbing.

Actually: do this minimal change here. Replace the literal `"char-trigger"` later. To preserve behavior and pass tests, this task uses `sourceId: \`char:\${ch}\`` derived from the trigger char.

```ts
store.openPopup({ sourceId: `char:${ch}`, trigger: ch, query: "", anchor: triggerPos });
```

- [ ] **Step 2: Update `refreshPopupItems` to use the new shape**

`refreshPopupItems` currently does `registry.query(trigger, q)`. Keep it for now — char-triggered behavior is unchanged. Only the field check changes:

```ts
const refreshPopupItems = useCallback((trigger: string | undefined, q: string) => {
  if (!trigger) return; // match-based path handled in Task 7
  const my = ++queryToken.current;
  void registry.query(trigger, q).then((items) => {
    if (my !== queryToken.current) return;
    const cur = store.snapshot().popup;
    if (!cur || cur.trigger !== trigger) return;
    store.setPopupItems(items);
  });
}, [registry, store]);
```

And the `useEffect` dependency list:

```ts
useEffect(() => {
  if (!popup) return;
  refreshPopupItems(popup.trigger, popup.query);
}, [popup?.trigger, popup?.query, refreshPopupItems]);
```

- [ ] **Step 3: Update `setBuffer` and `acceptPopup` to use `anchor`**

In `setBuffer`, replace the `tp = cur.triggerPos` block with:

```ts
const cur = store.snapshot().popup;
if (cur) {
  const tp = cur.anchor;
  if (cur.trigger !== undefined) {
    // Char-triggered popup: close when cursor moves before anchor or trigger char is deleted.
    if (newCursor <= tp || newValue[tp] !== cur.trigger) {
      store.closePopup();
    } else {
      const q = newValue.slice(tp + 1, newCursor);
      store.setPopupQuery(q);
    }
  }
  // Match-based path handled in Task 7.
}
```

In `acceptPopup`, replace `cur.triggerPos` with `cur.anchor`. (The slice math is unchanged.)

- [ ] **Step 4: Run InputBox tests**

```bash
cd plugins/llm-tui && bun test ui/InputBox.test.tsx
```

Existing tests reference `popup?.trigger`. Confirm they still pass. If any test reads `popup.triggerPos`, update to `popup.anchor`. Expected: PASS.

- [ ] **Step 5: Run full plugin tests**

```bash
cd plugins/llm-tui && bun test
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add plugins/llm-tui/ui/InputBox.tsx plugins/llm-tui/ui/InputBox.test.tsx
git commit -m "llm-tui: adapt InputBox to widened PopupState"
```

---

### Task 6: Track sources by id (replace trigger Set with Map)

**Files:**
- Modify: `plugins/llm-tui/index.tsx`

The `register()` wrapper in `index.tsx` tracks a `Set<string>` of trigger chars. We need to track sources keyed by id so the InputBox can look up the source object (for `match`-based activation in Task 7) and so the existing trigger-char path knows the source id.

- [ ] **Step 1: Replace the trigger Set with a Map**

In `plugins/llm-tui/index.tsx`, find the `triggers` block (around line 59-80). Replace with:

```ts
// Track registered sources by id. The InputBox derives both char-trigger
// activation and match-based activation from this map.
const sources = new Map<string, CompletionSource>();
const origRegister = registry.service.register;
registry.service.register = (source) => {
  sources.set(source.id, source);
  const off = origRegister(source);
  return () => {
    if (sources.get(source.id) === source) sources.delete(source.id);
    off();
  };
};
```

Add `import type { CompletionSource } from "llm-contracts/public";` at the top if not already imported.

- [ ] **Step 2: Update `InputBoxProps` to receive `sources` instead of `triggers`**

In `plugins/llm-tui/ui/InputBox.tsx`, change the prop type:

```ts
export interface InputBoxProps {
  store: TuiStore;
  registry: CompletionRegistry;
  sources: Map<string, CompletionSource>;
  theme: TuiTheme;
  onSubmit: (text: string) => void;
  onCancel?: () => void;
  onExit?: () => void;
  copyToClipboard?: (text: string) => Promise<CopyResult>;
}
```

Add `import type { CompletionSource } from "llm-contracts/public";` if needed.

- [ ] **Step 3: Update char-trigger detection to derive triggers from sources**

Inside the `InputBox` component, near the top, derive the trigger char map once per render:

```ts
const charTriggers = React.useMemo(() => {
  const m = new Map<string, CompletionSource>();
  for (const s of sources.values()) {
    if (s.trigger) m.set(s.trigger, s);
  }
  return m;
}, [sources]);
```

In the keypress loop (around line 440), replace `triggers.has(ch)` with `charTriggers.has(ch)` and use the source's id:

```ts
if (charTriggers.has(ch)) {
  const source = charTriggers.get(ch)!;
  const triggerPos = curPos;
  const okWordStart = atWordStart(next, triggerPos);
  const okOutsideQuote = !insideQuoteOrBacktick(next, triggerPos);
  if (okWordStart && okOutsideQuote) {
    curVal = next;
    curPos = newCursor;
    store.setInput(curVal, curPos);
    setHistIdx(null);
    store.openPopup({ sourceId: source.id, trigger: ch, query: "", anchor: triggerPos });
    didOpenPopup = true;
    continue;
  }
}
```

- [ ] **Step 4: Update call site in `index.tsx` where `<InputBox>` is rendered**

Find the `<App>` mount in `plugins/llm-tui/index.tsx` and follow it into `ui/App.tsx`. Pass `sources` instead of `triggers` through the prop chain. Replace any `triggers={...}` prop with `sources={sources}`. Update `App.tsx`'s `AppProps` accordingly.

- [ ] **Step 5: Update existing `InputBox.test.tsx` setup helper**

```bash
cd plugins/llm-tui && grep -n "triggers" ui/InputBox.test.tsx
```

In the `setup()` function, replace:

```ts
const triggers = new Set<string>();
```

with:

```ts
const sources = new Map<string, import("llm-contracts/public").CompletionSource>();
```

Wherever a test does `ctx.triggers.add("/")` and then registers a source, replace with:

```ts
const src = { id: "a", trigger: "/", list: () => [{ label: "/help", insertText: "/help " }] };
ctx.sources.set(src.id, src);
ctx.reg.service.register(src);
```

And update every `<InputBox … triggers={ctx.triggers} … />` to `<InputBox … sources={ctx.sources} … />`.

- [ ] **Step 6: Run tests**

```bash
cd plugins/llm-tui && bun test
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add plugins/llm-tui/index.tsx plugins/llm-tui/ui/App.tsx plugins/llm-tui/ui/InputBox.tsx plugins/llm-tui/ui/InputBox.test.tsx
git commit -m "llm-tui: track completion sources by id instead of trigger set"
```

---

### Task 7: Implement match-based activation in `InputBox`

**Files:**
- Modify: `plugins/llm-tui/ui/InputBox.tsx`
- Modify: `plugins/llm-tui/ui/InputBox.test.tsx`

- [ ] **Step 1: Write failing test**

Add to `plugins/llm-tui/ui/InputBox.test.tsx`:

```ts
it("opens popup from a match-based source", async () => {
  const ctx = setup();
  const src = {
    id: "args",
    match: (line: string, _cursor: number) => {
      if (line === "/foo bar") return { triggerPos: 5, query: "bar" };
      return null;
    },
    list: (q: string) => [{ label: `key:${q}`, insertText: `key:${q}` }],
  };
  ctx.sources.set(src.id, src);
  ctx.reg.service.register(src);
  const { stdin } = render(
    <InputBox store={ctx.store} registry={ctx.reg} sources={ctx.sources} theme={DEFAULT_THEME} onSubmit={ctx.onSubmit} />,
  );
  await tick();
  stdin.write("/foo bar");
  await tick(60);
  const popup = ctx.store.snapshot().popup;
  expect(popup?.sourceId).toBe("args");
  expect(popup?.anchor).toBe(5);
  expect(popup?.query).toBe("bar");
  expect(popup?.items.map(i => i.label)).toEqual(["key:bar"]);
});

it("closes match-based popup when match returns null", async () => {
  const ctx = setup();
  const src = {
    id: "args",
    match: (line: string, _c: number) => line.startsWith("/foo ") ? { triggerPos: 5, query: line.slice(5) } : null,
    list: (q: string) => [{ label: q, insertText: q }],
  };
  ctx.sources.set(src.id, src);
  ctx.reg.service.register(src);
  const { stdin } = render(
    <InputBox store={ctx.store} registry={ctx.reg} sources={ctx.sources} theme={DEFAULT_THEME} onSubmit={ctx.onSubmit} />,
  );
  await tick();
  stdin.write("/foo ");
  await tick(60);
  expect(ctx.store.snapshot().popup?.sourceId).toBe("args");
  // Backspace past the trigger boundary.
  stdin.write(""); // backspace x5
  await tick(60);
  expect(ctx.store.snapshot().popup).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify failure**

```bash
cd plugins/llm-tui && bun test ui/InputBox.test.tsx
```

Expected: FAIL — popup is null because no match-based activation exists yet.

- [ ] **Step 3: Add `queryBySource` to the completion registry**

In `plugins/llm-tui/completion/registry.ts`, extend the registry's public interface and implementation. Update:

```ts
export interface CompletionRegistry {
  service: UiCompletionService;
  query(trigger: string, q: string): Promise<CompletionItem[]>;
  queryBySource(sourceId: string, q: string, ctx?: { line: string; cursor: number }): Promise<CompletionItem[]>;
}
```

Implementation — add `queryBySource` alongside `query`. It mirrors `query` but filters by id:

```ts
async function queryBySource(sourceId: string, q: string, qctx?: { line: string; cursor: number }): Promise<CompletionItem[]> {
  if (pending) pending.resolve([]);
  if (timer) { clearTimeout(timer); timer = null; }
  return new Promise<CompletionItem[]>((resolve) => {
    pending = { trigger: "__by-id", q, resolve, sourceId, qctx };
    if (debounceMs <= 0) fireById();
    else timer = setTimeout(fireById, debounceMs);
  });
}

function fireById(): void {
  const job = pending;
  pending = null;
  timer = null;
  if (!job || !job.sourceId) return;
  const myToken = ++token;
  const src = sources.get(job.sourceId);
  if (!src) { job.resolve([]); return; }
  Promise.resolve()
    .then(() => src.list(job.q, job.qctx))
    .catch(() => [] as CompletionItem[])
    .then((items) => {
      if (myToken !== token) { job.resolve([]); return; }
      const arr = Array.isArray(items) ? items : [];
      arr.sort((a, b) => {
        const wa = a.sortWeight ?? 0; const wb = b.sortWeight ?? 0;
        if (wb !== wa) return wb - wa;
        return a.label.localeCompare(b.label);
      });
      job.resolve(arr);
    });
}
```

Widen the `Pending` interface to include `sourceId?: string; qctx?: { line: string; cursor: number }`. Return both `query` and `queryBySource` from `makeCompletionRegistry`.

- [ ] **Step 4: Add a registry test for `queryBySource`**

In `plugins/llm-tui/completion/registry.test.ts`:

```ts
it("queryBySource returns only the named source's items", async () => {
  const r = makeCompletionRegistry({ debounceMs: 0 });
  r.service.register({ id: "a", trigger: "/", list: () => [{ label: "A", insertText: "A" }] });
  r.service.register({ id: "b", match: () => null, list: (q) => [{ label: `B:${q}`, insertText: `B:${q}` }] });
  const items = await r.queryBySource("b", "hi");
  expect(items.map(i => i.label)).toEqual(["B:hi"]);
});

it("queryBySource resolves [] when source id is unknown", async () => {
  const r = makeCompletionRegistry({ debounceMs: 0 });
  const items = await r.queryBySource("missing", "q");
  expect(items).toEqual([]);
});
```

- [ ] **Step 5: Implement match-based activation in `InputBox`**

In `plugins/llm-tui/ui/InputBox.tsx`, after the existing keypress loop (and after `setBuffer`, the cursor/arrow handlers — search for the bottom of the `useInput` handler), add a post-mutation effect that re-evaluates `match` predicates on every line/cursor change:

```ts
useEffect(() => {
  const cur = store.snapshot().popup;
  // If a char-triggered popup is open, leave it alone — char path owns lifecycle.
  if (cur && cur.trigger !== undefined) return;

  // Find first match-based source whose predicate returns non-null.
  for (const src of sources.values()) {
    if (!src.match) continue;
    const hit = src.match(value, cursor);
    if (hit) {
      if (cur && cur.sourceId === src.id) {
        // Update anchor + query without re-creating popup.
        if (cur.anchor !== hit.triggerPos || cur.query !== hit.query) {
          store.openPopup({ sourceId: src.id, query: hit.query, anchor: hit.triggerPos });
        }
      } else {
        store.openPopup({ sourceId: src.id, query: hit.query, anchor: hit.triggerPos });
      }
      return;
    }
  }
  // No match-based source matches; if a match-based popup is open, close it.
  if (cur && cur.trigger === undefined) store.closePopup();
}, [value, cursor, sources, store]);
```

Then add a second effect that fetches items for match-based popups:

```ts
useEffect(() => {
  if (!popup || popup.trigger !== undefined) return;
  const my = ++queryToken.current;
  void registry.queryBySource(popup.sourceId, popup.query, { line: value, cursor }).then((items) => {
    if (my !== queryToken.current) return;
    const cur = store.snapshot().popup;
    if (!cur || cur.sourceId !== popup.sourceId) return;
    store.setPopupItems(items);
  });
}, [popup?.sourceId, popup?.query, popup?.trigger, value, cursor, registry, store]);
```

- [ ] **Step 6: Run tests**

```bash
cd plugins/llm-tui && bun test
```

Expected: all pass, including the two new tests from Step 1 and Step 4.

- [ ] **Step 7: Commit**

```bash
git add plugins/llm-tui/ui/InputBox.tsx plugins/llm-tui/ui/InputBox.test.tsx plugins/llm-tui/completion/registry.ts plugins/llm-tui/completion/registry.test.ts
git commit -m "llm-tui: implement match-based completion popup activation"
```

---

### Task 8: Deploy `llm-tui`

- [ ] **Step 1: Build and sync**

```bash
PLUGIN=llm-tui
VERSION=$(jq -r .version plugins/$PLUGIN/package.json)
INSTALL_DIR=~/.kaizen/marketplaces/official/plugins/${PLUGIN}@${VERSION}
(cd plugins/$PLUGIN && bun build --target=bun --outfile=dist/index.js index.tsx)
mkdir -p "$INSTALL_DIR/dist"
cp plugins/$PLUGIN/dist/index.js "$INSTALL_DIR/dist/index.js"
rsync -a --exclude='node_modules' --exclude='dist' plugins/$PLUGIN/ "$INSTALL_DIR/"
```

(Note: entry is `index.tsx`, not `.ts`.)

Expected: exits 0; no rsync errors.

---

## Phase 3 — `llm-slash-commands`: arg-completion source

### Task 9: Add `arg-completion.ts` parsing logic (pure)

**Files:**
- Create: `plugins/llm-slash-commands/arg-completion.ts`
- Create: `plugins/llm-slash-commands/arg-completion.test.ts`

- [ ] **Step 1: Write failing tests**

Create `plugins/llm-slash-commands/arg-completion.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { computeArgSlot } from "./arg-completion.ts";

describe("computeArgSlot", () => {
  it("returns null when line is not a slash command", () => {
    expect(computeArgSlot("hello world", 5)).toBeNull();
  });

  it("identifies slot 0 with empty query right after the command", () => {
    const r = computeArgSlot("/config:set ", 12);
    expect(r).toEqual({ name: "config:set", slotIndex: 0, prevArgs: [], query: "", anchor: 12, flagMode: false });
  });

  it("identifies slot 0 with partial token", () => {
    const r = computeArgSlot("/config:set kaiz", 16);
    expect(r).toEqual({ name: "config:set", slotIndex: 0, prevArgs: [], query: "kaiz", anchor: 12, flagMode: false });
  });

  it("identifies slot 1 with prev args populated", () => {
    const r = computeArgSlot("/config:set kaizen-config m", 27);
    expect(r).toEqual({ name: "config:set", slotIndex: 1, prevArgs: ["kaizen-config"], query: "m", anchor: 26, flagMode: false });
  });

  it("treats flags as non-positional", () => {
    const r = computeArgSlot("/config:set --project kaizen-config ", 36);
    // --project stripped from positional; slot 1 ready with prev=["kaizen-config"]
    expect(r?.slotIndex).toBe(1);
    expect(r?.prevArgs).toEqual(["kaizen-config"]);
    expect(r?.query).toBe("");
  });

  it("returns flagMode after all positional slots filled", () => {
    const r = computeArgSlot("/config:set kaizen-config model=gpt ", 36);
    expect(r?.flagMode).toBe(true);
    expect(r?.slotIndex).toBe(2);
    expect(r?.query).toBe("");
  });

  it("computes flagMode with partial flag token", () => {
    const r = computeArgSlot("/config:set kaizen-config model=gpt --pr", 40);
    expect(r?.flagMode).toBe(true);
    expect(r?.query).toBe("--pr");
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

```bash
cd plugins/llm-slash-commands && bun test arg-completion.test.ts
```

Expected: FAIL — `computeArgSlot` not found.

- [ ] **Step 3: Implement `arg-completion.ts`**

Create `plugins/llm-slash-commands/arg-completion.ts`:

```ts
import { parse } from "./parser.ts";
import type { SlashRegistryService, CompletionItem, CompletionSource } from "llm-contracts/public";

export interface ArgSlotInfo {
  name: string;
  slotIndex: number;
  prevArgs: string[];
  query: string;
  anchor: number;
  flagMode: boolean;
}

/**
 * Pure parsing: given a line and cursor position, returns the slot info
 * that argument completion should fire against. Returns null if the line
 * isn't a slash command or doesn't have a parseable slot at the cursor.
 *
 * Flag tokens (starting with "--") are stripped from positional slot index
 * computation but counted as flag-slot context when all positional slots are
 * filled.
 */
export function computeArgSlot(line: string, cursor: number): ArgSlotInfo | null {
  const parsed = parse(line);
  if (!parsed) return null;
  const argsStart = line.length - parsed.args.length;
  if (cursor < argsStart) return null;

  // Walk tokens in the args region up to the cursor, tracking each token's
  // [start, end) in absolute line coords.
  const tokens: Array<{ value: string; start: number; end: number; isFlag: boolean }> = [];
  let i = argsStart;
  while (i < line.length) {
    while (i < line.length && /\s/.test(line[i]!)) i++;
    if (i >= line.length) break;
    const start = i;
    while (i < line.length && !/\s/.test(line[i]!)) i++;
    const value = line.slice(start, i);
    tokens.push({ value, start, end: i, isFlag: value.startsWith("--") });
  }

  // Determine the token (or whitespace gap) under the cursor.
  let activeToken: { value: string; start: number; end: number; isFlag: boolean } | null = null;
  for (const t of tokens) {
    if (cursor >= t.start && cursor <= t.end) { activeToken = t; break; }
  }

  // Positional tokens before the cursor (excluding the active token if it's positional).
  const positionalBefore: string[] = [];
  for (const t of tokens) {
    if (activeToken && t === activeToken) break;
    if (t.end > cursor) break;
    if (!t.isFlag) positionalBefore.push(t.value);
  }

  const slotIndex = positionalBefore.length;
  const query = activeToken ? activeToken.value.slice(0, cursor - activeToken.start) : "";
  const anchor = activeToken ? activeToken.start : cursor;
  const flagMode = activeToken?.isFlag === true || (!activeToken && positionalBefore.length >= 2);
  // (slot count comparison is done by the caller via the manifest; this
  // function reports the raw slot index. Caller decides flagMode by checking
  // slotIndex >= manifest.arguments.length.)

  return {
    name: parsed.name,
    slotIndex,
    prevArgs: positionalBefore,
    query,
    anchor,
    flagMode,
  };
}
```

NOTE: the `flagMode` heuristic above is incomplete on its own — it returns `flagMode: true` when the user is mid-`--flag` token OR when they're past the last positional. The caller (in Task 10) refines this against the actual manifest's `arguments.length`. For now, the tests assert the raw behavior.

- [ ] **Step 4: Run tests**

```bash
cd plugins/llm-slash-commands && bun test arg-completion.test.ts
```

Expected: all 7 tests pass. If `flagMode` test for `"/config:set kaizen-config model=gpt "` fails (slotIndex=2 but flagMode=false because no active token), adjust: when `activeToken` is null and `positionalBefore.length >= 2`, set `flagMode = true`. (The fallback is already in the code; verify.)

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-slash-commands/arg-completion.ts plugins/llm-slash-commands/arg-completion.test.ts
git commit -m "llm-slash-commands: add computeArgSlot pure parser"
```

---

### Task 10: Build the arg-completion `CompletionSource`

**Files:**
- Modify: `plugins/llm-slash-commands/arg-completion.ts`
- Modify: `plugins/llm-slash-commands/arg-completion.test.ts`

- [ ] **Step 1: Write failing test**

Append to `plugins/llm-slash-commands/arg-completion.test.ts`:

```ts
import { buildArgCompletionSource } from "./arg-completion.ts";
import { createRegistry } from "./registry.ts";

describe("buildArgCompletionSource", () => {
  function withRegistry() {
    const reg = createRegistry();
    reg.register(
      {
        name: "config:set",
        description: "x",
        source: "plugin",
        arguments: [
          { name: "plugin", complete: async () => [{ label: "kaizen-config", insertText: "kaizen-config" }] },
          { name: "key=value", complete: async (prev) => [{ label: `${prev[0]}:k=v`, insertText: `k=v` }] },
        ],
        flags: [{ name: "--project" }],
      },
      async () => {},
    );
    return reg;
  }

  it("match returns non-null for slot 0", () => {
    const src = buildArgCompletionSource(withRegistry());
    const hit = src.match!("/config:set ", 12);
    expect(hit).toEqual({ triggerPos: 12, query: "" });
  });

  it("match returns null for unknown command", () => {
    const src = buildArgCompletionSource(withRegistry());
    expect(src.match!("/nope foo", 9)).toBeNull();
  });

  it("match returns null when slotIndex past arguments and no flags remaining", () => {
    const reg = createRegistry();
    reg.register(
      { name: "noflag:cmd", description: "x", source: "plugin", arguments: [{ name: "a" }] },
      async () => {},
    );
    const src = buildArgCompletionSource(reg);
    expect(src.match!("/noflag:cmd one two ", 20)).toBeNull();
  });

  it("list returns slot 0 completions", async () => {
    const src = buildArgCompletionSource(withRegistry());
    const items = await src.list("", { line: "/config:set ", cursor: 12 });
    expect(items.map(i => i.label)).toEqual(["kaizen-config"]);
  });

  it("list returns slot 1 completions with prev populated", async () => {
    const src = buildArgCompletionSource(withRegistry());
    const items = await src.list("", { line: "/config:set kaizen-config ", cursor: 26 });
    expect(items.map(i => i.label)).toEqual(["kaizen-config:k=v"]);
  });

  it("list returns flag suggestions when positional slots are filled", async () => {
    const src = buildArgCompletionSource(withRegistry());
    const items = await src.list("", { line: "/config:set kaizen-config k=v ", cursor: 30 });
    expect(items.map(i => i.label)).toEqual(["--project"]);
  });

  it("list excludes flags already present in the line", async () => {
    const src = buildArgCompletionSource(withRegistry());
    const items = await src.list("", { line: "/config:set kaizen-config k=v --project ", cursor: 40 });
    expect(items).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

```bash
cd plugins/llm-slash-commands && bun test arg-completion.test.ts
```

Expected: FAIL — `buildArgCompletionSource` not exported.

- [ ] **Step 3: Implement `buildArgCompletionSource`**

Append to `plugins/llm-slash-commands/arg-completion.ts`:

```ts
export function buildArgCompletionSource(registry: SlashRegistryService): CompletionSource {
  return {
    id: "llm-slash-commands:args",
    match(line, cursor) {
      const slot = computeArgSlot(line, cursor);
      if (!slot) return null;
      const entry = registry.get(slot.name);
      if (!entry) return null;
      const args = entry.manifest.arguments ?? [];
      const flags = entry.manifest.flags ?? [];

      // Positional slot in range?
      if (slot.slotIndex < args.length && !slot.flagMode) {
        if (!args[slot.slotIndex]!.complete) return null;
        return { triggerPos: slot.anchor, query: slot.query };
      }
      // Flag slot?
      if (slot.slotIndex >= args.length || slot.flagMode) {
        const flagsLeft = flags.filter((f) => !line.includes(` ${f.name}`));
        if (flagsLeft.length === 0) return null;
        return { triggerPos: slot.anchor, query: slot.query };
      }
      return null;
    },
    async list(_query, ctx) {
      if (!ctx) return [];
      const slot = computeArgSlot(ctx.line, ctx.cursor);
      if (!slot) return [];
      const entry = registry.get(slot.name);
      if (!entry) return [];
      const args = entry.manifest.arguments ?? [];
      const flags = entry.manifest.flags ?? [];

      if (slot.slotIndex < args.length && !slot.flagMode) {
        const fn = args[slot.slotIndex]!.complete;
        if (!fn) return [];
        return await fn(slot.prevArgs, slot.query);
      }
      // Flag slot.
      const present = new Set<string>();
      for (const tok of ctx.line.split(/\s+/)) {
        if (tok.startsWith("--")) present.add(tok);
      }
      return flags
        .filter((f) => !present.has(f.name))
        .map<CompletionItem>((f) => ({
          label: f.name,
          insertText: f.name,
          detail: f.description,
        }));
    },
  };
}
```

- [ ] **Step 4: Run tests**

```bash
cd plugins/llm-slash-commands && bun test arg-completion.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-slash-commands/arg-completion.ts plugins/llm-slash-commands/arg-completion.test.ts
git commit -m "llm-slash-commands: build arg-completion CompletionSource"
```

---

### Task 11: Register the arg-completion source on `harness:start`

**Files:**
- Modify: `plugins/llm-slash-commands/index.ts`
- Modify: `plugins/llm-slash-commands/integration.test.ts`

- [ ] **Step 1: Register the new source**

In `plugins/llm-slash-commands/index.ts`:

a) Add the import near the top:

```ts
import { buildArgCompletionSource } from "./arg-completion.ts";
```

b) Add a module-scope handle for cleanup (next to the existing `completionOff`):

```ts
let argCompletionOff: (() => void) | undefined;
```

c) In the `on("harness:start", …)` block, register the new source alongside the existing one:

```ts
on("harness:start", async () => {
  try {
    const completion = ctx.useService<UiCompletionService>("ui:completion-source");
    if (completion) {
      completionOff = completion.register(buildCompletionSource(registry));
      argCompletionOff = completion.register(buildArgCompletionSource(registry));
    }
  } catch { /* ui:completion-source absent — skip */ }
});
```

d) In `stop()`, clean up:

```ts
async stop() {
  try { completionOff?.(); } catch { /* idempotent */ }
  try { argCompletionOff?.(); } catch { /* idempotent */ }
  completionOff = undefined;
  argCompletionOff = undefined;
},
```

- [ ] **Step 2: Add an integration test**

Open `plugins/llm-slash-commands/integration.test.ts` and look for an existing test that mounts the plugin with a fake `ctx`. Add (or adapt) a test that:

1. Registers a fake completion service that captures registered sources.
2. Emits `harness:start`.
3. Asserts the captured sources include one with id `"llm-slash-commands:args"`.

Concrete addition (place inside the existing `describe` block):

```ts
it("registers an arg-completion source on harness:start", async () => {
  const registered: CompletionSource[] = [];
  const fakeCompletion: UiCompletionService = {
    register: (s) => { registered.push(s); return () => {}; },
  };
  // …existing fake-ctx setup that exposes useService("ui:completion-source") → fakeCompletion…
  // …mount the plugin and run setup…
  // …trigger ctx.emit("harness:start")…
  expect(registered.map(s => s.id)).toContain("llm-slash-commands:args");
});
```

If `integration.test.ts` doesn't already have the fake-ctx scaffolding for `useService`, copy the pattern from `dispatcher.test.ts` and adapt minimally — do NOT introduce a new test framework.

- [ ] **Step 3: Run tests**

```bash
cd plugins/llm-slash-commands && bun test
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add plugins/llm-slash-commands/index.ts plugins/llm-slash-commands/integration.test.ts
git commit -m "llm-slash-commands: register arg-completion source on harness:start"
```

---

### Task 12: Deploy `llm-slash-commands`

- [ ] **Step 1: Build and sync**

```bash
PLUGIN=llm-slash-commands
VERSION=$(jq -r .version plugins/$PLUGIN/package.json)
INSTALL_DIR=~/.kaizen/marketplaces/official/plugins/${PLUGIN}@${VERSION}
(cd plugins/$PLUGIN && bun build --target=bun --outfile=dist/index.js index.ts)
mkdir -p "$INSTALL_DIR/dist"
cp plugins/$PLUGIN/dist/index.js "$INSTALL_DIR/dist/index.js"
rsync -a --exclude='node_modules' --exclude='dist' plugins/$PLUGIN/ "$INSTALL_DIR/"
```

---

## Phase 4 — `kaizen-config`: slot declarations

### Task 13: Create `slash-completions.ts` helper

**Files:**
- Create: `plugins/kaizen-config/slash-completions.ts`
- Create: `plugins/kaizen-config/slash-completions.test.ts`

- [ ] **Step 1: Write failing tests**

Create `plugins/kaizen-config/slash-completions.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import type { ConfigSpec, ConfigStatus, ConfigStoreService, FieldSchema } from "llm-contracts/public";
import { pluginCompletions, keyEqualsValueCompletions, keyOnlyCompletions } from "./slash-completions.ts";

function makeStore(): ConfigStoreService {
  const statuses: ConfigStatus[] = [
    { plugin: "kaizen-config", homePath: "/h", projectPath: "/p", homeExists: true, projectExists: false, resolution: {} },
    { plugin: "openai-llm", homePath: "/h", projectPath: "/p", homeExists: false, projectExists: true, resolution: {} },
  ];
  const specs: Record<string, ConfigSpec<any>> = {
    "kaizen-config": {
      plugin: "kaizen-config",
      defaults: {},
      schema: {
        enabled: { type: "boolean" } as FieldSchema,
        backend: { type: "enum", values: ["env", "keychain"] } as FieldSchema,
        apiKey: { type: "string", secret: true } as FieldSchema,
        url: { type: "string" } as FieldSchema,
      },
    },
  };
  return {
    register: () => {},
    get: () => ({} as any),
    set: async () => {},
    watch: () => () => {},
    list: () => statuses,
    ready: async () => {},
    unset: async () => {},
    getSpec: (p) => specs[p],
  };
}

describe("pluginCompletions", () => {
  it("returns one item per registered plugin with resolution detail", async () => {
    const items = await pluginCompletions(makeStore());
    expect(items.map(i => i.label)).toEqual(["kaizen-config", "openai-llm"]);
    expect(items.find(i => i.label === "kaizen-config")?.detail).toBe("home");
    expect(items.find(i => i.label === "openai-llm")?.detail).toBe("project");
  });
});

describe("keyEqualsValueCompletions", () => {
  it("expands booleans into two items", async () => {
    const items = await keyEqualsValueCompletions(makeStore(), ["kaizen-config"]);
    const labels = items.map(i => i.label);
    expect(labels).toContain("enabled=true");
    expect(labels).toContain("enabled=false");
  });

  it("expands enums into one item per value", async () => {
    const items = await keyEqualsValueCompletions(makeStore(), ["kaizen-config"]);
    const labels = items.map(i => i.label);
    expect(labels).toContain("backend=env");
    expect(labels).toContain("backend=keychain");
  });

  it("appends '· secret' to detail for secret string fields", async () => {
    const items = await keyEqualsValueCompletions(makeStore(), ["kaizen-config"]);
    const apiKey = items.find(i => i.label === "apiKey");
    expect(apiKey?.detail).toContain("secret");
  });

  it("returns [] when plugin is unknown", async () => {
    const items = await keyEqualsValueCompletions(makeStore(), ["nope"]);
    expect(items).toEqual([]);
  });
});

describe("keyOnlyCompletions", () => {
  it("returns one item per top-level key with no '=' suffix", async () => {
    const items = await keyOnlyCompletions(makeStore(), ["kaizen-config"]);
    const labels = items.map(i => i.label);
    expect(labels.sort()).toEqual(["apiKey", "backend", "enabled", "url"].sort());
    for (const it of items) expect(it.insertText.includes("=")).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

```bash
cd plugins/kaizen-config && bun test slash-completions.test.ts
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `slash-completions.ts`**

Create `plugins/kaizen-config/slash-completions.ts`:

```ts
import type { CompletionItem, ConfigStoreService, FieldSchema } from "llm-contracts/public";

function resolutionDetail(homeExists: boolean, projectExists: boolean): string {
  const parts: string[] = [];
  if (homeExists) parts.push("home");
  if (projectExists) parts.push("project");
  return parts.length ? parts.join("+") : "(unset)";
}

export async function pluginCompletions(store: ConfigStoreService): Promise<CompletionItem[]> {
  return store.list().map((row) => ({
    label: row.plugin,
    insertText: row.plugin,
    detail: resolutionDetail(row.homeExists, row.projectExists),
  }));
}

function fieldDetail(field: FieldSchema): string {
  const base = field.type;
  if (field.type === "string" && field.secret) return `${base} · secret`;
  return base;
}

export async function keyEqualsValueCompletions(
  store: ConfigStoreService,
  prev: string[],
): Promise<CompletionItem[]> {
  const plugin = prev[0];
  if (!plugin) return [];
  const spec = store.getSpec(plugin);
  const schema = spec?.schema ?? {};
  const items: CompletionItem[] = [];
  for (const [key, field] of Object.entries(schema)) {
    if (!field) continue;
    const f = field as FieldSchema;
    const detail = fieldDetail(f);
    if (f.type === "boolean") {
      items.push({ label: `${key}=true`, insertText: `${key}=true`, detail });
      items.push({ label: `${key}=false`, insertText: `${key}=false`, detail });
    } else if (f.type === "enum") {
      for (const v of f.values) {
        items.push({ label: `${key}=${v}`, insertText: `${key}=${v}`, detail });
      }
    } else if (f.type === "string" && f.enum) {
      for (const v of f.enum) {
        items.push({ label: `${key}=${v}`, insertText: `${key}=${v}`, detail });
      }
    } else {
      items.push({ label: key, insertText: `${key}=`, detail });
    }
  }
  return items;
}

export async function keyOnlyCompletions(
  store: ConfigStoreService,
  prev: string[],
): Promise<CompletionItem[]> {
  const plugin = prev[0];
  if (!plugin) return [];
  const spec = store.getSpec(plugin);
  const schema = spec?.schema ?? {};
  const items: CompletionItem[] = [];
  for (const [key, field] of Object.entries(schema)) {
    if (!field) continue;
    items.push({ label: key, insertText: key, detail: fieldDetail(field as FieldSchema) });
  }
  return items;
}
```

- [ ] **Step 4: Run tests**

```bash
cd plugins/kaizen-config && bun test slash-completions.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add plugins/kaizen-config/slash-completions.ts plugins/kaizen-config/slash-completions.test.ts
git commit -m "kaizen-config: add slash-completions helper module"
```

---

### Task 14: Declare `arguments`/`flags` on each manifest

**Files:**
- Modify: `plugins/kaizen-config/slash.ts`

- [ ] **Step 1: Import helpers and update `config:set` manifest**

At the top of `plugins/kaizen-config/slash.ts`, add:

```ts
import { pluginCompletions, keyEqualsValueCompletions, keyOnlyCompletions } from "./slash-completions.ts";
```

Find the `config:set` registration (search for `name: "config:set"`). Replace its manifest object with:

```ts
{
  name: "config:set",
  description: "Set a config value. Usage: /config:set <plugin> <key>=<value> [--project]",
  source: "plugin",
  arguments: [
    { name: "plugin", complete: () => pluginCompletions(deps.store) },
    { name: "key=value", complete: (prev) => keyEqualsValueCompletions(deps.store, prev) },
  ],
  flags: [{ name: "--project", description: "Write to project scope" }],
},
```

- [ ] **Step 2: Update `config:get` manifest**

Find the `config:get` registration. Replace its manifest object with:

```ts
{
  name: "config:get",
  description: "Print the merged config for a plugin. Usage: /config:get <plugin> [key.path] [--reveal]",
  source: "plugin",
  arguments: [
    { name: "plugin", complete: () => pluginCompletions(deps.store) },
    { name: "key", complete: (prev) => keyOnlyCompletions(deps.store, prev) },
  ],
  flags: [{ name: "--reveal", description: "Reveal secret values" }],
},
```

- [ ] **Step 3: Update `config:unset` manifest**

Find the `config:unset` registration. Replace its manifest object with:

```ts
{
  name: "config:unset",
  description: "Remove a config key. Usage: /config:unset <plugin> <key> [--project]",
  source: "plugin",
  arguments: [
    { name: "plugin", complete: () => pluginCompletions(deps.store) },
    { name: "key", complete: (prev) => keyOnlyCompletions(deps.store, prev) },
  ],
  flags: [{ name: "--project", description: "Write to project scope" }],
},
```

- [ ] **Step 4: Run tests**

```bash
cd plugins/kaizen-config && bun test
```

Expected: existing tests pass (manifest additions are backwards-compatible; handler logic unchanged).

- [ ] **Step 5: Commit**

```bash
git add plugins/kaizen-config/slash.ts
git commit -m "kaizen-config: declare arguments and flags on config slash commands"
```

---

### Task 15: Deploy `kaizen-config`

- [ ] **Step 1: Build and sync**

```bash
PLUGIN=kaizen-config
VERSION=$(jq -r .version plugins/$PLUGIN/package.json)
INSTALL_DIR=~/.kaizen/marketplaces/official/plugins/${PLUGIN}@${VERSION}
(cd plugins/$PLUGIN && bun build --target=bun --outfile=dist/index.js index.ts)
mkdir -p "$INSTALL_DIR/dist"
cp plugins/$PLUGIN/dist/index.js "$INSTALL_DIR/dist/index.js"
rsync -a --exclude='node_modules' --exclude='dist' plugins/$PLUGIN/ "$INSTALL_DIR/"
```

---

## Phase 5 — End-to-end manual verification

### Task 16: Smoke-test in the running harness

- [ ] **Step 1: Launch the local harness**

```bash
kaizen --harness ./harnesses/local.json
```

- [ ] **Step 2: Verify `/config:set` flow**

In the TUI:

1. Type `/config:set ` (with trailing space). Popup MUST appear listing registered plugins.
2. Tab to select a plugin. Popup closes; line shows `/config:set <plugin>`.
3. Type a space. Popup re-opens with the plugin's schema keys (and value shortcuts for booleans/enums).
4. Tab to select `key=value` or a `key=true`-style item. Popup closes; line shows `/config:set <plugin> key=value`.
5. Type a space. Popup re-opens offering `--project`. Pick it or press Enter to submit.

- [ ] **Step 3: Verify `/config:get` and `/config:unset`**

Repeat the flow for `/config:get <plugin> <key> [--reveal]` and `/config:unset <plugin> <key> [--project]`. Both should drive the popup through plugin → key → flag (with `--reveal` instead of `--project` for get).

- [ ] **Step 4: Verify `/`-trigger regression**

Type `/` from an empty input. The original command-name popup MUST still appear. Pick `/help`, hit Enter. Confirm it still works.

- [ ] **Step 5: Done**

No commit needed for manual verification. If a regression is found, return to the relevant phase and fix.

---

## Self-review notes

- All spec requirements covered by tasks: contracts (Tasks 1-2), TUI store widening (Task 4), TUI activation (Tasks 5-7), TUI deploy (Task 8), slash arg-completion (Tasks 9-11), kaizen-config completions (Tasks 13-14), all three deploys (Tasks 3, 8, 12, 15).
- TDD pattern applied to every code-producing task: failing test first, run-to-verify-failure, implementation, run-to-verify-pass, commit.
- Every step shows the actual code, command, or expected output the engineer needs.
- Type and field names are consistent: `PopupState.sourceId`, `PopupState.anchor`, `ArgSlot.complete`, `SlashCommandFlag.name`, `buildArgCompletionSource`, `pluginCompletions`/`keyEqualsValueCompletions`/`keyOnlyCompletions`.
- Repo conventions followed: commits straight to `main`, no `Co-Authored-By`, no `document-and-commit` skill.
- Local-deploy order (contracts → tui/slash-commands → kaizen-config) matches the spec's deploy-order section and `docs/PLUGIN_ARCHITECTURE.md`.
