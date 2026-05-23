# Centralized Completion-Menu Filtering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every completion menu in the harness narrows as the user types using one rule (case-insensitive substring of the slot query against the item's label), and any future plugin that registers a slash argument inherits the behavior for free.

**Architecture:** Add one optional field (`selfFilters?: boolean`) to `ArgSlot` in `llm-contracts`. Centralize filtering in the slash-arg dispatcher (`llm-slash-commands/arg-completion.ts`) — it post-filters every plugin's `complete()` result by `slot.query` against the item label unless the slot opts out. The slash-name source self-filters in `llm-slash-commands/completion.ts`. The only slot that opts out is `kaizen-config`'s `key=value`, which parses structure and owns both tiers itself.

**Tech Stack:** Bun workspace monorepo. TypeScript. `bun:test`. `kaizen plugin validate`. `bun build --target=bun --outfile=dist/index.js`.

**Spec:** `docs/superpowers/specs/2026-05-22-config-completion-filtering-design.md`.

**Deploy order (load-bearing):** `llm-contracts` → `llm-slash-commands` → `kaizen-config`. The contract must boot first because the consuming plugins compile against the new `ArgSlot.selfFilters` field.

---

## File map

**Create**
- `plugins/llm-slash-commands/query-match.ts` — `matchesQuery`, `filterByQuery`.
- `plugins/llm-slash-commands/query-match.test.ts` — helper unit tests.
- `plugins/kaizen-config/query-match.ts` — same helpers, duplicated.
- `plugins/kaizen-config/query-match.test.ts` — helper unit tests.

**Modify**
- `plugins/llm-contracts/contracts/slash-registry.ts` — add `selfFilters?: boolean` to `ArgSlot`.
- `plugins/llm-slash-commands/completion.ts` — `startsWith` → `matchesQuery`.
- `plugins/llm-slash-commands/test/completion.test.ts` — substring + case-fold tests.
- `plugins/llm-slash-commands/arg-completion.ts` — dispatcher post-filter (positional + flag).
- `plugins/llm-slash-commands/arg-completion.test.ts` — dispatcher filter + opt-out tests.
- `plugins/kaizen-config/slash.ts` — mark `key=value` slot `selfFilters: true`.
- `plugins/kaizen-config/slash-completions.ts` — filter the pre-`=` branch in `keyEqualsValueCompletions`.
- `plugins/kaizen-config/slash-completions.test.ts` — pre-`=` filter tests; value-tier prefix → substring.
- `plugins/kaizen-config/field-rendering.ts` — `startsWith` → `matchesQuery` in `renderValueRows`.
- `plugins/kaizen-config/field-rendering.test.ts` — prefix tests → substring + case-fold.

---

## Task 1: Add `selfFilters?: boolean` to `ArgSlot`

**Files:**
- Modify: `plugins/llm-contracts/contracts/slash-registry.ts:3-8`

- [ ] **Step 1: Update the contract**

Edit `plugins/llm-contracts/contracts/slash-registry.ts` to add the field:

```ts
export interface ArgSlot {
  name: string;
  description?: string;
  complete?: (prev: string[], query: string) =>
    Promise<CompletionItem[]> | CompletionItem[];
  /**
   * When true, the slash-arg dispatcher will NOT post-filter results from
   * `complete`. The plugin is responsible for filtering against `query`
   * itself. Use only when `query` is structured (e.g. `key=value`) and a
   * label-substring filter would over-filter.
   */
  selfFilters?: boolean;
}
```

- [ ] **Step 2: Run the contracts test suite**

```sh
cd plugins/llm-contracts && bun test
```

Expected: PASS — the existing defineService tests still cover this contract; no behavior changes.

- [ ] **Step 3: Commit**

```sh
git add plugins/llm-contracts/contracts/slash-registry.ts
git commit -m "llm-contracts: add ArgSlot.selfFilters for dispatcher-level filter opt-out"
```

---

## Task 2: Validate and deploy `llm-contracts`

**Files:** None modified; build artefacts only. Must complete before downstream plugins consume the new field.

- [ ] **Step 1: Run plugin validation**

```sh
kaizen plugin validate plugins/llm-contracts
```

Expected: success.

- [ ] **Step 2: Build and sync into the install dir**

```sh
PLUGIN=llm-contracts
VERSION=$(jq -r .version plugins/$PLUGIN/package.json)
INSTALL_DIR=~/.kaizen/marketplaces/official/plugins/${PLUGIN}@${VERSION}
(cd plugins/$PLUGIN && bun build --target=bun --outfile=dist/index.js index.ts)
mkdir -p "$INSTALL_DIR/dist"
cp plugins/$PLUGIN/dist/index.js "$INSTALL_DIR/dist/index.js"
rsync -a --exclude='node_modules' --exclude='dist' plugins/$PLUGIN/ "$INSTALL_DIR/"
```

Expected: clean build; rsync reports changed files including `contracts/slash-registry.ts` and `public.d.ts` (if regenerated).

- [ ] **Step 3: Smoke-check the install**

```sh
ls -la ~/.kaizen/marketplaces/official/plugins/llm-contracts@${VERSION}/dist/index.js
grep -n selfFilters ~/.kaizen/marketplaces/official/plugins/llm-contracts@${VERSION}/contracts/slash-registry.ts
```

Expected: both succeed; `selfFilters` appears in the installed contracts file.

---

## Task 3: `query-match` helper in `llm-slash-commands` (TDD)

**Files:**
- Create: `plugins/llm-slash-commands/query-match.ts`
- Create: `plugins/llm-slash-commands/query-match.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `plugins/llm-slash-commands/query-match.test.ts` (lives in the plugin root, same dir as the helper):

```ts
import { describe, it, expect } from "bun:test";
import { matchesQuery, filterByQuery } from "./query-match.ts";

describe("matchesQuery", () => {
  it("returns true for empty / whitespace query", () => {
    expect(matchesQuery("anything", "")).toBe(true);
    expect(matchesQuery("anything", "   ")).toBe(true);
  });

  it("matches case-insensitive substring (not just prefix)", () => {
    expect(matchesQuery("config:set", "set")).toBe(true);
    expect(matchesQuery("config:set", "CONFIG")).toBe(true);
    expect(matchesQuery("apiKey", "Key")).toBe(true);
  });

  it("returns false when no substring match", () => {
    expect(matchesQuery("config:set", "zzz")).toBe(false);
  });
});

describe("filterByQuery", () => {
  const items = [
    { label: "/help", detail: "help" },
    { label: "/config:get", detail: "get" },
    { label: "/config:set", detail: "set" },
  ];

  it("empty query returns all items unchanged", () => {
    expect(filterByQuery(items, "")).toEqual(items);
    expect(filterByQuery(items, "   ")).toEqual(items);
  });

  it("filters by case-insensitive substring of label", () => {
    expect(filterByQuery(items, "CONFIG").map((i) => i.label))
      .toEqual(["/config:get", "/config:set"]);
    expect(filterByQuery(items, "set").map((i) => i.label))
      .toEqual(["/config:set"]);
  });

  it("matches label only, not detail", () => {
    const itemsWithDetailMatch = [{ label: "/x", detail: "set" }];
    expect(filterByQuery(itemsWithDetailMatch, "set")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```sh
cd plugins/llm-slash-commands && bun test query-match.test.ts
```

Expected: FAIL — `query-match.ts` does not exist.

- [ ] **Step 3: Write the helper**

Create `plugins/llm-slash-commands/query-match.ts`:

```ts
export function matchesQuery(haystack: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return haystack.toLowerCase().includes(q);
}

export function filterByQuery<T extends { label: string }>(items: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((item) => item.label.toLowerCase().includes(q));
}
```

- [ ] **Step 4: Run tests to verify they pass**

```sh
cd plugins/llm-slash-commands && bun test query-match.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add plugins/llm-slash-commands/query-match.ts plugins/llm-slash-commands/query-match.test.ts
git commit -m "llm-slash-commands: add matchesQuery + filterByQuery helpers"
```

---

## Task 4: Slash-name source → substring + case-fold (TDD)

**Files:**
- Modify: `plugins/llm-slash-commands/test/completion.test.ts:14-22`
- Modify: `plugins/llm-slash-commands/completion.ts:14-29`

- [ ] **Step 1: Replace prefix tests with substring + case-fold tests**

In `plugins/llm-slash-commands/test/completion.test.ts`, replace the existing test labelled `"filters by prefix (query is text AFTER the slash)"` and append two new tests:

```ts
  it("filters by case-insensitive substring of name", async () => {
    const reg = createRegistry();
    registerBuiltins(reg);
    reg.register({ name: "mcp:reload", description: "r", source: "plugin" }, async () => {});
    const src = buildCompletionSource(reg);
    const items = await src.list("he");
    expect(items.map((i) => i.label)).toEqual(["/help"]);
  });

  it("matches substring anywhere in the name", async () => {
    const reg = createRegistry();
    reg.register({ name: "config:get", description: "g", source: "plugin" }, async () => {});
    reg.register({ name: "session:list", description: "l", source: "plugin" }, async () => {});
    const src = buildCompletionSource(reg);
    const items = await src.list("config");
    expect(items.map((i) => i.label)).toEqual(["/config:get"]);
  });

  it("case-folds the query", async () => {
    const reg = createRegistry();
    registerBuiltins(reg);
    const src = buildCompletionSource(reg);
    const items = await src.list("HELP");
    expect(items.map((i) => i.label)).toEqual(["/help"]);
  });
```

Leave the `"filters by namespace prefix"` test in place — substring is a superset of prefix, so it stays green.

- [ ] **Step 2: Run tests to verify they fail**

```sh
cd plugins/llm-slash-commands && bun test test/completion.test.ts
```

Expected: FAIL — `src.list("HELP")` returns nothing because `startsWith` is case-sensitive.

- [ ] **Step 3: Swap `startsWith` for `matchesQuery`**

Update `plugins/llm-slash-commands/completion.ts`:

```ts
import type { SlashRegistryService, SlashCommandManifest } from "./registry.ts";
import type { CompletionItem, CompletionSource } from "llm-contracts/public";
import { matchesQuery } from "./query-match.ts";

function rank(m: SlashCommandManifest): number {
  if (m.source === "builtin" && !m.name.includes(":")) return 0;
  if (m.source === "file") return 1;
  return 2;
}

export function buildCompletionSource(registry: SlashRegistryService): CompletionSource {
  return {
    id: "llm-slash-commands:registry",
    trigger: "/",
    async list(query: string): Promise<CompletionItem[]> {
      const all = registry.list();
      return all
        .filter((m) => matchesQuery(m.name, query))
        .sort((a, b) => {
          const ra = rank(a), rb = rank(b);
          if (ra !== rb) return ra - rb;
          return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
        })
        .map((m) => ({
          label: `/${m.name}`,
          insertText: `/${m.name} `,
          detail: m.description,
        }));
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```sh
cd plugins/llm-slash-commands && bun test test/completion.test.ts
```

Expected: PASS — new substring + case-fold tests plus all unchanged tests.

- [ ] **Step 5: Commit**

```sh
git add plugins/llm-slash-commands/completion.ts plugins/llm-slash-commands/test/completion.test.ts
git commit -m "llm-slash-commands: slash-name menu uses substring + case-fold filter"
```

---

## Task 5: Arg dispatcher — positional branch filtering + opt-out (TDD)

**Files:**
- Modify: `plugins/llm-slash-commands/arg-completion.test.ts`
- Modify: `plugins/llm-slash-commands/arg-completion.ts:87-100`

- [ ] **Step 1: Add failing tests for positional-slot filtering and opt-out**

In `plugins/llm-slash-commands/arg-completion.test.ts`, append new tests inside `describe("buildArgCompletionSource", ...)`. The existing `withRegistry()` helper registers two args; add new helpers and tests:

```ts
  function withQueryUnawareSlot() {
    const reg = createRegistry();
    reg.register(
      {
        name: "qun:cmd",
        description: "x",
        source: "plugin",
        arguments: [
          // complete returns the FULL list — dispatcher should filter.
          { name: "plugin", complete: async () => [
            { label: "kaizen-config", insertText: "kaizen-config " },
            { label: "openai-llm",    insertText: "openai-llm "    },
          ] },
        ],
      },
      async () => {},
    );
    return reg;
  }

  function withSelfFilterSlot() {
    const reg = createRegistry();
    reg.register(
      {
        name: "self:cmd",
        description: "x",
        source: "plugin",
        arguments: [
          { name: "key=value",
            selfFilters: true,
            complete: async () => [
              { label: "✓ keychain", insertText: "backend=keychain " },
              { label: "  env",      insertText: "backend=env "      },
            ],
          },
        ],
      },
      async () => {},
    );
    return reg;
  }

  it("positional slot: dispatcher filters by slot query against label (substring + case-fold)", async () => {
    const src = buildArgCompletionSource(withQueryUnawareSlot());
    const items = await src.list("", { line: "/qun:cmd KAI", cursor: 12 });
    expect(items.map((i) => i.label)).toEqual(["kaizen-config"]);
  });

  it("positional slot: empty slot query returns all plugin items unchanged", async () => {
    const src = buildArgCompletionSource(withQueryUnawareSlot());
    const items = await src.list("", { line: "/qun:cmd ", cursor: 9 });
    expect(items.map((i) => i.label).sort()).toEqual(["kaizen-config", "openai-llm"]);
  });

  it("positional slot: selfFilters: true bypasses dispatcher filter", async () => {
    const src = buildArgCompletionSource(withSelfFilterSlot());
    // Query 'env' would normally filter the '✓ keychain' label out.
    // With selfFilters: true, dispatcher must NOT filter — both rows return.
    const items = await src.list("", { line: "/self:cmd env", cursor: 13 });
    expect(items.map((i) => i.label).sort()).toEqual(["  env", "✓ keychain"]);
  });
```

The existing `"list returns slot 0 completions"` and `"list returns slot 1 completions with prev populated"` tests use empty slot queries and stay green.

- [ ] **Step 2: Run tests to verify they fail**

```sh
cd plugins/llm-slash-commands && bun test arg-completion.test.ts
```

Expected: FAIL — `KAI` query returns both items because the dispatcher doesn't filter, and `selfFilters: true` opt-out doesn't yet exist.

- [ ] **Step 3: Add the dispatcher filter and opt-out**

In `plugins/llm-slash-commands/arg-completion.ts`, add the helper import and update the positional branch in `list()`:

```ts
import { matchesQuery, filterByQuery } from "./query-match.ts";
```

```ts
      if (slot.slotIndex < args.length && !slot.flagMode) {
        const argSpec = args[slot.slotIndex]!;
        const fn = argSpec.complete;
        if (!fn) return [];
        const items = await fn(slot.prevArgs, slot.query);
        return argSpec.selfFilters ? items : filterByQuery(items, slot.query);
      }
```

- [ ] **Step 4: Run tests to verify they pass**

```sh
cd plugins/llm-slash-commands && bun test arg-completion.test.ts
```

Expected: PASS — new dispatcher-filter and opt-out tests plus all existing tests.

- [ ] **Step 5: Commit**

```sh
git add plugins/llm-slash-commands/arg-completion.ts plugins/llm-slash-commands/arg-completion.test.ts
git commit -m "llm-slash-commands: dispatcher post-filters positional slots with selfFilters opt-out"
```

---

## Task 6: Arg dispatcher — flag-slot filtering (TDD)

**Files:**
- Modify: `plugins/llm-slash-commands/arg-completion.test.ts`
- Modify: `plugins/llm-slash-commands/arg-completion.ts:102-114`

- [ ] **Step 1: Add failing tests for flag filtering**

Append to `plugins/llm-slash-commands/arg-completion.test.ts` inside `describe("buildArgCompletionSource", ...)`:

```ts
  function withTwoFlags() {
    const reg = createRegistry();
    reg.register(
      {
        name: "flags:cmd",
        description: "x",
        source: "plugin",
        arguments: [{ name: "a", complete: async () => [{ label: "first", insertText: "first " }] }],
        flags: [
          { name: "--project", description: "p" },
          { name: "--reveal",  description: "r" },
        ],
      },
      async () => {},
    );
    return reg;
  }

  it("flag slot: filters flags by case-insensitive substring of slot query", async () => {
    const src = buildArgCompletionSource(withTwoFlags());
    const items = await src.list("", { line: "/flags:cmd a --pro", cursor: 18 });
    expect(items.map((i) => i.label)).toEqual(["--project"]);
  });

  it("flag slot: case-folds the query", async () => {
    const src = buildArgCompletionSource(withTwoFlags());
    const items = await src.list("", { line: "/flags:cmd a --REVEAL", cursor: 21 });
    expect(items.map((i) => i.label)).toEqual(["--reveal"]);
  });

  it("flag slot: empty slot query returns all unconsumed flags (regression)", async () => {
    const src = buildArgCompletionSource(withTwoFlags());
    const items = await src.list("", { line: "/flags:cmd a ", cursor: 13 });
    expect(items.map((i) => i.label).sort()).toEqual(["--project", "--reveal"]);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

```sh
cd plugins/llm-slash-commands && bun test arg-completion.test.ts
```

Expected: FAIL — `--pro` query returns both flags because the flag branch ignores `slot.query`.

- [ ] **Step 3: Filter the flag branch**

In `plugins/llm-slash-commands/arg-completion.ts`, update the flag branch:

```ts
      // Flag slot: return one item per declared flag not yet present in the line.
      const present = new Set<string>();
      for (const tok of ctx.line.split(/\s+/)) {
        if (tok.startsWith("--")) present.add(tok);
      }
      return flags
        .filter((f) => !present.has(f.name))
        .filter((f) => matchesQuery(f.name, slot.query))
        .map<CompletionItem>((f) => ({
          label: f.name,
          insertText: `${f.name} `,
          detail: f.description,
        }));
```

- [ ] **Step 4: Run tests to verify they pass**

```sh
cd plugins/llm-slash-commands && bun test arg-completion.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run the whole plugin suite**

```sh
cd plugins/llm-slash-commands && bun test
```

Expected: PASS — every test in the plugin.

- [ ] **Step 6: Commit**

```sh
git add plugins/llm-slash-commands/arg-completion.ts plugins/llm-slash-commands/arg-completion.test.ts
git commit -m "llm-slash-commands: flag-slot menu filters by slot query"
```

---

## Task 7: Validate and deploy `llm-slash-commands`

**Files:** None modified; build artefacts only.

- [ ] **Step 1: Run plugin validation**

```sh
kaizen plugin validate plugins/llm-slash-commands
```

Expected: success.

- [ ] **Step 2: Build and sync into the install dir**

```sh
PLUGIN=llm-slash-commands
VERSION=$(jq -r .version plugins/$PLUGIN/package.json)
INSTALL_DIR=~/.kaizen/marketplaces/official/plugins/${PLUGIN}@${VERSION}
(cd plugins/$PLUGIN && bun build --target=bun --outfile=dist/index.js index.ts)
mkdir -p "$INSTALL_DIR/dist"
cp plugins/$PLUGIN/dist/index.js "$INSTALL_DIR/dist/index.js"
rsync -a --exclude='node_modules' --exclude='dist' plugins/$PLUGIN/ "$INSTALL_DIR/"
```

- [ ] **Step 3: Smoke-check the install**

```sh
ls -la ~/.kaizen/marketplaces/official/plugins/llm-slash-commands@${VERSION}/dist/index.js
```

Expected: file exists with recent mtime.

---

## Task 8: `query-match` helper in `kaizen-config` (TDD)

**Files:**
- Create: `plugins/kaizen-config/query-match.ts`
- Create: `plugins/kaizen-config/query-match.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `plugins/kaizen-config/query-match.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { matchesQuery, filterByQuery } from "./query-match.ts";

describe("matchesQuery", () => {
  it("returns true for empty / whitespace query", () => {
    expect(matchesQuery("anything", "")).toBe(true);
    expect(matchesQuery("anything", "   ")).toBe(true);
  });

  it("matches case-insensitive substring (not just prefix)", () => {
    expect(matchesQuery("apiKey", "key")).toBe(true);
    expect(matchesQuery("apiKey", "KEY")).toBe(true);
    expect(matchesQuery("apiKey", "iK")).toBe(true);
  });

  it("returns false when no substring match", () => {
    expect(matchesQuery("apiKey", "zzz")).toBe(false);
  });
});

describe("filterByQuery", () => {
  const items = [
    { label: "apiKey", detail: "string · secret" },
    { label: "backend", detail: "enum" },
    { label: "enabled", detail: "boolean" },
  ];

  it("empty query returns all items unchanged", () => {
    expect(filterByQuery(items, "")).toEqual(items);
  });

  it("filters by case-insensitive substring of label", () => {
    expect(filterByQuery(items, "key").map((i) => i.label)).toEqual(["apiKey"]);
    expect(filterByQuery(items, "KEY").map((i) => i.label)).toEqual(["apiKey"]);
    expect(filterByQuery(items, "en").map((i) => i.label)).toEqual(["backend", "enabled"]);
  });

  it("matches label only, not detail", () => {
    expect(filterByQuery(items, "secret")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```sh
cd plugins/kaizen-config && bun test query-match.test.ts
```

Expected: FAIL — `query-match.ts` does not exist.

- [ ] **Step 3: Write the helper**

Create `plugins/kaizen-config/query-match.ts`:

```ts
export function matchesQuery(haystack: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return haystack.toLowerCase().includes(q);
}

export function filterByQuery<T extends { label: string }>(items: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((item) => item.label.toLowerCase().includes(q));
}
```

- [ ] **Step 4: Run tests to verify they pass**

```sh
cd plugins/kaizen-config && bun test query-match.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add plugins/kaizen-config/query-match.ts plugins/kaizen-config/query-match.test.ts
git commit -m "kaizen-config: add matchesQuery + filterByQuery helpers"
```

---

## Task 9: Mark `key=value` slot with `selfFilters: true`

**Files:**
- Modify: `plugins/kaizen-config/slash.ts:101-105`

The slot has a structured query (`key=value`), so the dispatcher's plain-substring filter on label would over-filter. The plugin owns both the key tier and the value tier internally.

- [ ] **Step 1: Update the `/config:set` slot definition**

In `plugins/kaizen-config/slash.ts`, change the `arguments` array for `/config:set`:

```ts
      arguments: [
        { name: "plugin",    complete: () => pluginCompletions(deps.store) },
        { name: "key=value", complete: (prev, query) => keyEqualsValueCompletions(deps.store, prev, query), selfFilters: true },
      ],
```

Leave `/config:get` and `/config:unset` slot definitions unchanged — their plugin and key slots have plain labels and benefit from dispatcher filtering for free.

- [ ] **Step 2: Run the kaizen-config suite**

```sh
cd plugins/kaizen-config && bun test
```

Expected: PASS — all existing tests; behavioral change is gated by the dispatcher work in `llm-slash-commands` and is exercised via unit tests there.

- [ ] **Step 3: Commit**

```sh
git add plugins/kaizen-config/slash.ts
git commit -m "kaizen-config: opt key=value slot out of dispatcher filtering"
```

---

## Task 10: Filter the key tier of `keyEqualsValueCompletions` (TDD)

The slot is now `selfFilters: true`, so the dispatcher won't filter for us. The plugin must filter the pre-`=` (key tier) rows itself; the post-`=` (value tier) is already filtered via `renderValueRows` and gets its rule updated in the next task.

**Files:**
- Modify: `plugins/kaizen-config/slash-completions.test.ts` (inside `describe("keyEqualsValueCompletions", ...)`)
- Modify: `plugins/kaizen-config/slash-completions.ts:43-57`

- [ ] **Step 1: Add failing tests for the key tier**

Append inside `describe("keyEqualsValueCompletions", ...)` in `plugins/kaizen-config/slash-completions.test.ts`:

```ts
  it("field tier: filters fields by case-insensitive substring of pre-= query", async () => {
    const store = storeWith(
      { enabled: true, backend: "keychain", apiKey: "x", url: "https://x" },
      { enabled: "home", backend: "home", apiKey: "home", url: "home" },
    );
    const items = await keyEqualsValueCompletions(store, ["kaizen-config"], "back");
    expect(items.map((i) => i.label)).toEqual(["backend"]);
  });

  it("field tier: case-folds the query", async () => {
    const store = storeWith(
      { enabled: true, backend: "keychain", apiKey: "x", url: "https://x" },
      { enabled: "home", backend: "home", apiKey: "home", url: "home" },
    );
    const items = await keyEqualsValueCompletions(store, ["kaizen-config"], "KEY");
    expect(items.map((i) => i.label)).toEqual(["apiKey"]);
  });

  it("field tier: empty query returns all fields (regression)", async () => {
    const store = storeWith(
      { enabled: true, backend: "keychain", apiKey: "x", url: "https://x" },
      { enabled: "home", backend: "home", apiKey: "home", url: "home" },
    );
    const items = await keyEqualsValueCompletions(store, ["kaizen-config"], "");
    expect(items.map((i) => i.label).sort()).toEqual(["apiKey", "backend", "enabled", "url"]);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

```sh
cd plugins/kaizen-config && bun test slash-completions.test.ts
```

Expected: FAIL — query `"back"` returns all four fields because the key-tier branch ignores `query`.

- [ ] **Step 3: Apply `filterByQuery` to the key-tier branch**

In `plugins/kaizen-config/slash-completions.ts`, add the import and update the `eqIdx === -1` branch:

```ts
import { filterByQuery } from "./query-match.ts";

// ...

  const eqIdx = query.indexOf("=");
  if (eqIdx === -1) {
    const rows: CompletionItem[] = [];
    for (const [key, field] of Object.entries(schema)) {
      if (!field) continue;
      const source = resolution[key] ?? "default";
      rows.push(renderFieldRow({
        key,
        field,
        currentValue: merged[key],
        source,
        isSet: source !== "default",
      }));
    }
    return filterByQuery(rows, query);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

```sh
cd plugins/kaizen-config && bun test slash-completions.test.ts
```

Expected: PASS — including the existing `"field tier (empty query): one row per field"` test (empty query is a no-op).

- [ ] **Step 5: Commit**

```sh
git add plugins/kaizen-config/slash-completions.ts plugins/kaizen-config/slash-completions.test.ts
git commit -m "kaizen-config: filter /config:set key tier (pre-=) by query"
```

---

## Task 11: Value tier — prefix → substring + case-fold (TDD)

**Files:**
- Modify: `plugins/kaizen-config/field-rendering.test.ts:248-264`
- Modify: `plugins/kaizen-config/slash-completions.test.ts` (existing `"value tier: filters by post-= text"` test)
- Modify: `plugins/kaizen-config/field-rendering.ts:112-131`

- [ ] **Step 1: Convert value-tier prefix tests to substring + case-fold**

In `plugins/kaizen-config/field-rendering.test.ts`, replace the two existing prefix tests (`"filters rows by valueQuery prefix"` and `"filters booleans by valueQuery prefix"`) with:

```ts
  it("filters enum rows by case-insensitive substring of valueQuery", () => {
    const rows = renderValueRows(inputs({
      key: "backend",
      field: { type: "enum", values: ["env", "keychain", "bitwarden"] },
      currentValue: "keychain",
    }), "ch");
    expect(rows.map((r) => r.label)).toEqual(["✓ keychain"]);
  });

  it("filters enum rows case-insensitively", () => {
    const rows = renderValueRows(inputs({
      key: "backend",
      field: { type: "enum", values: ["env", "keychain", "bitwarden"] },
      currentValue: "keychain",
    }), "KEY");
    expect(rows.map((r) => r.label)).toEqual(["✓ keychain"]);
  });

  it("filters booleans by substring of valueQuery", () => {
    const rows = renderValueRows(inputs({
      key: "x",
      field: { type: "boolean" },
      currentValue: true,
    }), "ru");
    expect(rows.map((r) => r.label)).toEqual(["✓ true"]);
  });
```

In `plugins/kaizen-config/slash-completions.test.ts`, replace the existing `"value tier: filters by post-= text"` test with:

```ts
  it("value tier: filters by case-insensitive substring of post-= text", async () => {
    const store = storeWith({ backend: "env" }, { backend: "home" });
    const items = await keyEqualsValueCompletions(store, ["kaizen-config"], "backend=ch");
    expect(items.map((i) => i.label)).toEqual(["  keychain"]);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

```sh
cd plugins/kaizen-config && bun test field-rendering.test.ts slash-completions.test.ts
```

Expected: FAIL — `startsWith("ch")` matches nothing in `["env", "keychain", "bitwarden"]`, and case-sensitive `startsWith("KEY")` matches nothing.

- [ ] **Step 3: Replace `startsWith` with `matchesQuery` in `renderValueRows`**

In `plugins/kaizen-config/field-rendering.ts`, add the import and update both filter sites:

```ts
import { matchesQuery } from "./query-match.ts";
```

```ts
export function renderValueRows(input: RenderInputs, valueQuery: string): CompletionItem[] {
  const tag = typeTag(input.field);
  const current = input.currentValue;

  if (input.field.type === "boolean") {
    const all = ["true", "false"];
    return all
      .filter((v) => matchesQuery(v, valueQuery))
      .map((v) => valueRow(input.key, v, current === (v === "true"), tag));
  }

  const enumVals = enumValues(input.field);
  if (enumVals) {
    return enumVals
      .filter((v) => matchesQuery(v, valueQuery))
      .map((v) => valueRow(input.key, v, current === v, tag));
  }

  return [];
}
```

- [ ] **Step 4: Run the full kaizen-config suite**

```sh
cd plugins/kaizen-config && bun test
```

Expected: PASS — entire suite. The unchanged value-tier tests (e.g. enum render order) stay green; the prefix tests have been converted; new case-fold tests pass.

- [ ] **Step 5: Commit**

```sh
git add plugins/kaizen-config/field-rendering.ts plugins/kaizen-config/field-rendering.test.ts plugins/kaizen-config/slash-completions.test.ts
git commit -m "kaizen-config: value tier filters by case-insensitive substring"
```

---

## Task 12: Validate and deploy `kaizen-config`

**Files:** None modified; build artefacts only.

- [ ] **Step 1: Run plugin validation**

```sh
kaizen plugin validate plugins/kaizen-config
```

Expected: success.

- [ ] **Step 2: Build and sync into the install dir**

```sh
PLUGIN=kaizen-config
VERSION=$(jq -r .version plugins/$PLUGIN/package.json)
INSTALL_DIR=~/.kaizen/marketplaces/official/plugins/${PLUGIN}@${VERSION}
(cd plugins/$PLUGIN && bun build --target=bun --outfile=dist/index.js index.ts)
mkdir -p "$INSTALL_DIR/dist"
cp plugins/$PLUGIN/dist/index.js "$INSTALL_DIR/dist/index.js"
rsync -a --exclude='node_modules' --exclude='dist' plugins/$PLUGIN/ "$INSTALL_DIR/"
```

- [ ] **Step 3: Smoke-check the install**

```sh
ls -la ~/.kaizen/marketplaces/official/plugins/kaizen-config@${VERSION}/dist/index.js
```

Expected: file exists with recent mtime.

---

## Task 13: End-to-end manual smoke test

**Files:** None.

- [ ] **Step 1: Boot a fresh local harness**

Exit any running kaizen process first (the runtime caches modules and would show pre-fix behavior).

```sh
kaizen --harness ./harnesses/local.json
```

- [ ] **Step 2: Slash-name menu — substring + case-fold**

Type `/conf` — popup narrows to `/config:*` entries.
Type `/CONFIG` — same set (case-fold).
Type `/set` — `/config:set` appears (substring, not prefix).

- [ ] **Step 3: Plugin menu — substring + case-fold (dispatcher-filtered)**

Type `/config:set kai` — only `kaizen-config` appears.
Type `/config:set KAI` — same.

- [ ] **Step 4: Key menu (no `=`) — substring + case-fold (dispatcher-filtered)**

Type `/config:get kaizen-config key` — only `apiKey` appears.
Type `/config:unset kaizen-config back` — only `backend` appears.

- [ ] **Step 5: Set key tier (pre-`=`) — substring + case-fold (plugin-filtered via `selfFilters` opt-out)**

Type `/config:set kaizen-config back` — only `backend=` row appears.
Type `/config:set kaizen-config KEY` — only `apiKey=` row appears.

- [ ] **Step 6: Set value tier (post-`=`) — substring + case-fold**

Type `/config:set kaizen-config backend=ch` — only `keychain` appears.
Type `/config:set kaizen-config backend=KEY` — `keychain` still appears.

- [ ] **Step 7: Flag menu — narrows as typed**

Type `/config:get kaizen-config --rev` — only `--reveal` appears.
Type `/config:set kaizen-config foo=bar --pro` — only `--project` appears.

- [ ] **Step 8: Empty-query regression — full lists still appear**

Type `/` — every registered command appears.
Type `/config:set ` — every registered plugin appears.
Type `/config:set kaizen-config ` — every schema field appears.
Type `/config:set kaizen-config backend=` — `env` and `keychain` both appear.

If any step fails, stop, do not mark the task complete, and roll forward with a fix on the relevant plugin before re-deploying.

---

## Notes for the executor

- **Order matters**: `llm-contracts` (Tasks 1–2) → `llm-slash-commands` (Tasks 3–7) → `kaizen-config` (Tasks 8–12). The contract field must exist in the installed `llm-contracts` before downstream plugins import it.
- Bun test file placement matches existing conventions per plugin:
  - `kaizen-config`: tests live in the plugin root (`slash-completions.test.ts`, `field-rendering.test.ts`).
  - `llm-slash-commands`: most tests live in `test/` (`test/completion.test.ts`), but `arg-completion.test.ts` is in the plugin root. New `query-match.test.ts` goes in the plugin root (alongside the helper).
- Don't bump plugin versions in `package.json`. This change ships as a feature in the current versions of all three plugins.
- Commits go straight to `main`. No PRs, no `Co-Authored-By` lines, no `document-and-commit` skill.
- Before Task 13, exit any running kaizen process and re-launch. The runtime caches modules — a stale process will show pre-fix behavior.
