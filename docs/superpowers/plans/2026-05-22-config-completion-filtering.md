# Completion-Menu Filtering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every completion menu in the harness narrow as the user types, using one rule: case-insensitive substring of the in-progress token against the item's `label`. Empty query is a no-op.

**Architecture:** Per-callsite filtering across two plugins (no contract change). Each plugin gets a tiny `query-match.ts` helper with `matchesQuery(haystack, query)` and `filterByQuery(items, query)`. Six callsites are touched: three `complete:` callbacks in `kaizen-config`, the `renderValueRows` filter in `kaizen-config`, the slash-name source in `llm-slash-commands`, and the flag-slot branch of the arg source in `llm-slash-commands`.

**Tech Stack:** Bun workspace monorepo. TypeScript. `bun:test`. `kaizen plugin validate`. `bun build --target=bun --outfile=dist/index.js`.

**Spec:** `docs/superpowers/specs/2026-05-22-config-completion-filtering-design.md`.

---

## File map

**Create**
- `plugins/kaizen-config/query-match.ts` — `matchesQuery`, `filterByQuery`.
- `plugins/kaizen-config/query-match.test.ts` — unit tests for the helpers.
- `plugins/llm-slash-commands/query-match.ts` — same helpers.
- `plugins/llm-slash-commands/query-match.test.ts` — unit tests.

**Modify**
- `plugins/kaizen-config/slash-completions.ts` — add `query` param to `pluginCompletions` and `keyOnlyCompletions`; filter the key-tier branch in `keyEqualsValueCompletions`.
- `plugins/kaizen-config/slash-completions.test.ts` — add filtering tests; existing tests must stay green.
- `plugins/kaizen-config/slash.ts` — thread `query` into the three `complete:` callsites for the plugin/key slots.
- `plugins/kaizen-config/field-rendering.ts` — `startsWith(valueQuery)` → `matchesQuery(v, valueQuery)`.
- `plugins/kaizen-config/field-rendering.test.ts` — convert prefix tests to substring; add a case-fold case.
- `plugins/llm-slash-commands/completion.ts` — `name.startsWith(query)` → `matchesQuery(m.name, query)`.
- `plugins/llm-slash-commands/test/completion.test.ts` — convert prefix tests to substring; add case-fold case.
- `plugins/llm-slash-commands/arg-completion.ts` — filter the flag-slot branch by `slot.query`.
- `plugins/llm-slash-commands/arg-completion.test.ts` — add flag-filter tests.

---

## Task 1: `query-match` helper in kaizen-config (TDD)

**Files:**
- Create: `plugins/kaizen-config/query-match.ts`
- Create: `plugins/kaizen-config/query-match.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `plugins/kaizen-config/query-match.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { matchesQuery, filterByQuery } from "./query-match.ts";

describe("matchesQuery", () => {
  it("returns true for empty / whitespace query (no-op)", () => {
    expect(matchesQuery("anything", "")).toBe(true);
    expect(matchesQuery("anything", "   ")).toBe(true);
  });

  it("matches case-insensitive substring", () => {
    expect(matchesQuery("apiKey", "key")).toBe(true);
    expect(matchesQuery("apiKey", "KEY")).toBe(true);
    expect(matchesQuery("apiKey", "API")).toBe(true);
  });

  it("matches substring, not just prefix", () => {
    expect(matchesQuery("apiKey", "iK")).toBe(true);
    expect(matchesQuery("keychain", "chain")).toBe(true);
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
    expect(filterByQuery(items, "   ")).toEqual(items);
  });

  it("filters by case-insensitive substring of label", () => {
    expect(filterByQuery(items, "key").map((i) => i.label)).toEqual(["apiKey"]);
    expect(filterByQuery(items, "KEY").map((i) => i.label)).toEqual(["apiKey"]);
    expect(filterByQuery(items, "en").map((i) => i.label)).toEqual(["backend", "enabled"]);
  });

  it("matches label only, not detail", () => {
    // "secret" appears in detail, not label — must be filtered out.
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

Expected: PASS — all eight assertions green.

- [ ] **Step 5: Commit**

```sh
git add plugins/kaizen-config/query-match.ts plugins/kaizen-config/query-match.test.ts
git commit -m "kaizen-config: add matchesQuery + filterByQuery helpers"
```

---

## Task 2: Wire query into `pluginCompletions` and `keyOnlyCompletions` (TDD)

**Files:**
- Test: `plugins/kaizen-config/slash-completions.test.ts`
- Modify: `plugins/kaizen-config/slash-completions.ts`

- [ ] **Step 1: Write the failing tests**

Append to `plugins/kaizen-config/slash-completions.test.ts` (inside `describe("pluginCompletions", ...)`):

```ts
  it("filters by case-insensitive substring of plugin name", async () => {
    const items = await pluginCompletions(makeStore(), "kai");
    expect(items.map((i) => i.label)).toEqual(["kaizen-config"]);
  });

  it("returns all rows when query is empty (regression: old call shape still works)", async () => {
    const items = await pluginCompletions(makeStore(), "");
    expect(items.map((i) => i.label)).toEqual(["kaizen-config", "openai-llm"]);
  });

  it("case-folds the query", async () => {
    const items = await pluginCompletions(makeStore(), "OPENAI");
    expect(items.map((i) => i.label)).toEqual(["openai-llm"]);
  });
```

Append inside `describe("keyOnlyCompletions", ...)`:

```ts
  it("filters keys by case-insensitive substring", async () => {
    const store = storeWith({}, {});
    const items = await keyOnlyCompletions(store, ["kaizen-config"], "key");
    expect(items.map((i) => i.label)).toEqual(["apiKey"]);
  });

  it("empty query returns all keys (regression)", async () => {
    const store = storeWith({}, {});
    const items = await keyOnlyCompletions(store, ["kaizen-config"], "");
    expect(items.map((i) => i.label).sort()).toEqual(["apiKey", "backend", "enabled", "url"]);
  });

  it("case-folds the key query", async () => {
    const store = storeWith({}, {});
    const items = await keyOnlyCompletions(store, ["kaizen-config"], "KEY");
    expect(items.map((i) => i.label)).toEqual(["apiKey"]);
  });
```

The existing test that called `pluginCompletions(makeStore())` and `keyOnlyCompletions(store, ["kaizen-config"])` must keep working — we'll default `query` to `""` in the implementation so prior call sites are still legal.

- [ ] **Step 2: Run tests to verify they fail**

```sh
cd plugins/kaizen-config && bun test slash-completions.test.ts
```

Expected: FAIL — `pluginCompletions(makeStore(), "kai")` returns both plugins because the function ignores its query.

- [ ] **Step 3: Update `slash-completions.ts`**

Replace `pluginCompletions` and `keyOnlyCompletions` in `plugins/kaizen-config/slash-completions.ts`:

```ts
import { filterByQuery } from "./query-match.ts";

// ...

export async function pluginCompletions(
  store: ConfigStoreService,
  query: string = "",
): Promise<CompletionItem[]> {
  const rows = store.list().map((row) => ({
    label: row.plugin,
    insertText: `${row.plugin} `,
    detail: resolutionDetail(row.homeExists, row.projectExists),
  }));
  return filterByQuery(rows, query);
}
```

```ts
export async function keyOnlyCompletions(
  store: ConfigStoreService,
  prev: string[],
  query: string = "",
): Promise<CompletionItem[]> {
  const plugin = prev[0];
  if (!plugin) return [];
  const spec = store.getSpec(plugin);
  const schema = spec?.schema as Record<string, FieldSchema | undefined> | undefined;
  if (!schema) return [];

  let merged: Record<string, unknown> = {};
  try {
    merged = store.get(plugin) as Record<string, unknown>;
  } catch {
    merged = {};
  }
  const status = store.list().find((r) => r.plugin === plugin);
  const resolution = (status?.resolution ?? {}) as Record<string, ConfigResolutionSource>;

  const rows: CompletionItem[] = [];
  for (const [key, field] of Object.entries(schema)) {
    if (!field) continue;
    const source = resolution[key] ?? "default";
    const row = renderFieldRow({
      key, field, currentValue: merged[key], source, isSet: source !== "default",
    });
    rows.push({ label: row.label, insertText: `${key} `, detail: row.detail });
  }
  return filterByQuery(rows, query);
}
```

- [ ] **Step 4: Run tests to verify they pass**

```sh
cd plugins/kaizen-config && bun test slash-completions.test.ts
```

Expected: PASS — every test in `pluginCompletions` and `keyOnlyCompletions` describe blocks.

- [ ] **Step 5: Commit**

```sh
git add plugins/kaizen-config/slash-completions.ts plugins/kaizen-config/slash-completions.test.ts
git commit -m "kaizen-config: filter plugin and key completion menus by query"
```

---

## Task 3: Filter the key tier of `keyEqualsValueCompletions` (TDD)

**Files:**
- Test: `plugins/kaizen-config/slash-completions.test.ts`
- Modify: `plugins/kaizen-config/slash-completions.ts`

- [ ] **Step 1: Write the failing test**

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

Expected: FAIL — query `"back"` returns all four fields because the key tier ignores its query.

- [ ] **Step 3: Filter the key tier in `keyEqualsValueCompletions`**

In `plugins/kaizen-config/slash-completions.ts`, update the `eqIdx === -1` branch:

```ts
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

(`filterByQuery` is already imported from Task 2.)

- [ ] **Step 4: Run tests to verify they pass**

```sh
cd plugins/kaizen-config && bun test slash-completions.test.ts
```

Expected: PASS — all new tests plus all existing `keyEqualsValueCompletions` tests, including `"field tier (empty query): one row per field"`.

- [ ] **Step 5: Commit**

```sh
git add plugins/kaizen-config/slash-completions.ts plugins/kaizen-config/slash-completions.test.ts
git commit -m "kaizen-config: filter /config:set key tier by pre-= query"
```

---

## Task 4: Thread query into `slash.ts` callsites

**Files:**
- Modify: `plugins/kaizen-config/slash.ts:67-71, 100-105, 134-139`

- [ ] **Step 1: Update the three `complete:` callsites**

In `plugins/kaizen-config/slash.ts`, change all three places where `pluginCompletions` and `keyOnlyCompletions` are called from the slash-argument registry. The registry signature is `(prev: string[], query: string)`.

`/config:get`:

```ts
      arguments: [
        { name: "plugin", complete: (_prev, query) => pluginCompletions(deps.store, query) },
        { name: "key",    complete: (prev, query)  => keyOnlyCompletions(deps.store, prev, query) },
      ],
```

`/config:set`:

```ts
      arguments: [
        { name: "plugin",    complete: (_prev, query) => pluginCompletions(deps.store, query) },
        { name: "key=value", complete: (prev, query)  => keyEqualsValueCompletions(deps.store, prev, query) },
      ],
```

(The `keyEqualsValueCompletions` line is unchanged in behavior — it already takes the query — but the parameter names are made consistent.)

`/config:unset`:

```ts
      arguments: [
        { name: "plugin", complete: (_prev, query) => pluginCompletions(deps.store, query) },
        { name: "key",    complete: (prev, query)  => keyOnlyCompletions(deps.store, prev, query) },
      ],
```

- [ ] **Step 2: Run the full plugin test suite**

```sh
cd plugins/kaizen-config && bun test
```

Expected: PASS — slash-completions tests cover the function-level behavior; slash.ts tests (if any cover this path) must remain green. Search-and-replace nothing else.

- [ ] **Step 3: Commit**

```sh
git add plugins/kaizen-config/slash.ts
git commit -m "kaizen-config: thread slot query into plugin/key complete callbacks"
```

---

## Task 5: Switch value tier from prefix to substring (TDD)

**Files:**
- Modify: `plugins/kaizen-config/field-rendering.test.ts:248-264`
- Modify: `plugins/kaizen-config/field-rendering.ts:112-131`

- [ ] **Step 1: Convert the value-tier filter tests from prefix to substring**

In `plugins/kaizen-config/field-rendering.test.ts`, replace the two existing prefix tests:

```ts
  it("filters enum rows by case-insensitive substring of valueQuery", () => {
    const rows = renderValueRows(inputs({
      key: "backend",
      field: { type: "enum", values: ["env", "keychain", "bitwarden"] },
      currentValue: "keychain",
    }), "ch");
    expect(rows.map(r => r.label)).toEqual(["✓ keychain"]);
  });

  it("filters enum rows case-insensitively", () => {
    const rows = renderValueRows(inputs({
      key: "backend",
      field: { type: "enum", values: ["env", "keychain", "bitwarden"] },
      currentValue: "keychain",
    }), "KEY");
    expect(rows.map(r => r.label)).toEqual(["✓ keychain"]);
  });

  it("filters booleans by substring of valueQuery", () => {
    const rows = renderValueRows(inputs({
      key: "x",
      field: { type: "boolean" },
      currentValue: true,
    }), "ru");
    expect(rows.map(r => r.label)).toEqual(["✓ true"]);
  });
```

(Replaces the two `... by valueQuery prefix` tests at the same location.)

Also, in `plugins/kaizen-config/slash-completions.test.ts`, replace the existing test `"value tier: filters by post-= text"` with:

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

Expected: FAIL — `startsWith("ch")` matches nothing in `["env", "keychain", "bitwarden"]`, and `startsWith("KEY")` matches nothing case-sensitively.

- [ ] **Step 3: Replace `startsWith` with `matchesQuery` in `field-rendering.ts`**

At the top of `plugins/kaizen-config/field-rendering.ts`:

```ts
import { matchesQuery } from "./query-match.ts";
```

In `renderValueRows`:

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

- [ ] **Step 4: Run tests to verify they pass**

```sh
cd plugins/kaizen-config && bun test
```

Expected: PASS — entire kaizen-config suite, including the new substring/case tests and all unchanged tests.

- [ ] **Step 5: Commit**

```sh
git add plugins/kaizen-config/field-rendering.ts plugins/kaizen-config/field-rendering.test.ts plugins/kaizen-config/slash-completions.test.ts
git commit -m "kaizen-config: value tier filters by case-insensitive substring"
```

---

## Task 6: Validate and deploy `kaizen-config`

**Files:** None modified; build artefacts only.

- [ ] **Step 1: Run plugin validation**

```sh
kaizen plugin validate plugins/kaizen-config
```

Expected: success (no errors). If it warns about anything new, stop and reconcile before deploying.

- [ ] **Step 2: Build the bundle**

```sh
cd plugins/kaizen-config && bun build --target=bun --outfile=dist/index.js index.ts
```

Expected: clean build, no errors. `dist/index.js` updated.

- [ ] **Step 3: Sync into the install dir**

```sh
PLUGIN=kaizen-config
VERSION=$(jq -r .version plugins/$PLUGIN/package.json)
INSTALL_DIR=~/.kaizen/marketplaces/official/plugins/${PLUGIN}@${VERSION}
mkdir -p "$INSTALL_DIR/dist"
cp plugins/$PLUGIN/dist/index.js "$INSTALL_DIR/dist/index.js"
rsync -a --exclude='node_modules' --exclude='dist' plugins/$PLUGIN/ "$INSTALL_DIR/"
```

Expected: rsync reports the changed files; install dir has the new bundle and source.

- [ ] **Step 4: Smoke-check the install**

```sh
ls -la ~/.kaizen/marketplaces/official/plugins/kaizen-config@${VERSION}/dist/index.js
```

Expected: file exists and mtime is recent (within the last minute).

No commit step — deploy artefacts are not in the repo.

---

## Task 7: `query-match` helper in llm-slash-commands (TDD)

**Files:**
- Create: `plugins/llm-slash-commands/query-match.ts`
- Create: `plugins/llm-slash-commands/query-match.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `plugins/llm-slash-commands/query-match.test.ts` (file lives in the plugin root, same dir as the helper):

```ts
import { describe, it, expect } from "bun:test";
import { matchesQuery, filterByQuery } from "./query-match.ts";

describe("matchesQuery", () => {
  it("returns true for empty / whitespace query", () => {
    expect(matchesQuery("anything", "")).toBe(true);
    expect(matchesQuery("anything", "   ")).toBe(true);
  });

  it("matches case-insensitive substring", () => {
    expect(matchesQuery("config:set", "CONFIG")).toBe(true);
    expect(matchesQuery("config:set", "set")).toBe(true);
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
  });

  it("filters by case-insensitive substring of label", () => {
    expect(filterByQuery(items, "CONFIG").map((i) => i.label))
      .toEqual(["/config:get", "/config:set"]);
  });

  it("matches label only, not detail", () => {
    expect(filterByQuery(items, "help").map((i) => i.label)).toEqual(["/help"]);
    // 'get' appears in detail of /config:get but the label match still wins
    // on its own merits — but a label-only check excludes /config:set whose detail says 'set'.
    expect(filterByQuery([{ label: "/x", detail: "set" }], "set")).toEqual([]);
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

Expected: PASS — all assertions green.

- [ ] **Step 5: Commit**

```sh
git add plugins/llm-slash-commands/query-match.ts plugins/llm-slash-commands/query-match.test.ts
git commit -m "llm-slash-commands: add matchesQuery + filterByQuery helpers"
```

---

## Task 8: Slash-name source → substring + case-fold (TDD)

**Files:**
- Modify: `plugins/llm-slash-commands/test/completion.test.ts:14-22, 45-53`
- Modify: `plugins/llm-slash-commands/completion.ts:14-29`

- [ ] **Step 1: Update completion tests for substring behavior**

In `plugins/llm-slash-commands/test/completion.test.ts`, replace the `"filters by prefix (query is text AFTER the slash)"` test:

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

The existing `"filters by namespace prefix"` test (asserting `session` returns both `session:list` and `session:new`) still passes because substring matches what prefix matched — leave it alone.

- [ ] **Step 2: Run tests to verify they fail**

```sh
cd plugins/llm-slash-commands && bun test test/completion.test.ts
```

Expected: FAIL — `src.list("HELP")` returns nothing because of case-sensitive `startsWith`.

- [ ] **Step 3: Swap `startsWith` for `matchesQuery`**

In `plugins/llm-slash-commands/completion.ts`:

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

Expected: PASS — new substring + case-fold tests plus all unchanged tests in the file.

- [ ] **Step 5: Commit**

```sh
git add plugins/llm-slash-commands/completion.ts plugins/llm-slash-commands/test/completion.test.ts
git commit -m "llm-slash-commands: slash-name menu filters by case-insensitive substring"
```

---

## Task 9: Flag-slot filter in arg-completion (TDD)

**Files:**
- Modify: `plugins/llm-slash-commands/arg-completion.test.ts:99-109`
- Modify: `plugins/llm-slash-commands/arg-completion.ts:102-114`

- [ ] **Step 1: Add failing tests for flag filtering**

In `plugins/llm-slash-commands/arg-completion.test.ts`, append a new `withFlags` helper and tests inside `describe("buildArgCompletionSource", ...)`:

```ts
  function withTwoFlags() {
    const reg = createRegistry();
    reg.register(
      {
        name: "flags:cmd",
        description: "x",
        source: "plugin",
        arguments: [{ name: "a", complete: async () => [{ label: "first", insertText: "first" }] }],
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

  it("flag slot: empty query returns all unconsumed flags (regression)", async () => {
    const src = buildArgCompletionSource(withTwoFlags());
    const items = await src.list("", { line: "/flags:cmd a ", cursor: 13 });
    expect(items.map((i) => i.label).sort()).toEqual(["--project", "--reveal"]);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

```sh
cd plugins/llm-slash-commands && bun test arg-completion.test.ts
```

Expected: FAIL — typing `--pro` returns both flags because the flag list ignores `slot.query`.

- [ ] **Step 3: Add the filter in `arg-completion.ts`**

At the top of `plugins/llm-slash-commands/arg-completion.ts`:

```ts
import { matchesQuery } from "./query-match.ts";
```

In the `list()` function, replace the flag-slot branch:

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

(The first `.filter` for already-present flags is unchanged; the new line adds the query filter.)

- [ ] **Step 4: Run tests to verify they pass**

```sh
cd plugins/llm-slash-commands && bun test arg-completion.test.ts
```

Expected: PASS — the three new tests and all existing tests (including `"list excludes flags already present in the line"` and `"list returns flag suggestions when positional slots are filled"`, which uses empty query — falls through filter).

- [ ] **Step 5: Run the full plugin suite to catch integration regressions**

```sh
cd plugins/llm-slash-commands && bun test
```

Expected: PASS — every test in the plugin.

- [ ] **Step 6: Commit**

```sh
git add plugins/llm-slash-commands/arg-completion.ts plugins/llm-slash-commands/arg-completion.test.ts
git commit -m "llm-slash-commands: flag menu filters by slot query"
```

---

## Task 10: Validate and deploy `llm-slash-commands`

**Files:** None modified; build artefacts only.

- [ ] **Step 1: Run plugin validation**

```sh
kaizen plugin validate plugins/llm-slash-commands
```

Expected: success.

- [ ] **Step 2: Build the bundle**

```sh
cd plugins/llm-slash-commands && bun build --target=bun --outfile=dist/index.js index.ts
```

Expected: clean build.

- [ ] **Step 3: Sync into the install dir**

```sh
PLUGIN=llm-slash-commands
VERSION=$(jq -r .version plugins/$PLUGIN/package.json)
INSTALL_DIR=~/.kaizen/marketplaces/official/plugins/${PLUGIN}@${VERSION}
mkdir -p "$INSTALL_DIR/dist"
cp plugins/$PLUGIN/dist/index.js "$INSTALL_DIR/dist/index.js"
rsync -a --exclude='node_modules' --exclude='dist' plugins/$PLUGIN/ "$INSTALL_DIR/"
```

- [ ] **Step 4: Smoke-check the install**

```sh
ls -la ~/.kaizen/marketplaces/official/plugins/llm-slash-commands@${VERSION}/dist/index.js
```

Expected: file exists and mtime is recent.

---

## Task 11: End-to-end manual smoke test

**Files:** None.

- [ ] **Step 1: Boot a local harness**

```sh
kaizen --harness ./harnesses/local.json
```

- [ ] **Step 2: Slash-name menu — substring + case-fold**

Type `/conf` and confirm the popup narrows to `/config:*` entries.
Type `/CONFIG` and confirm it still narrows (case-fold).
Type `/set` and confirm it shows `/config:set` (substring, not prefix).

Expected: every keystroke narrows the menu; no menu shows unrelated commands.

- [ ] **Step 3: Plugin menu — substring + case-fold**

Type `/config:set kai` and confirm only `kaizen-config` appears in the plugin slot.
Type `/config:set KAI` and confirm the same.

- [ ] **Step 4: Key menu — substring + case-fold**

Type `/config:get kaizen-config key` and confirm only `apiKey` appears.
Type `/config:set kaizen-config back` and confirm only `backend=` appears.

- [ ] **Step 5: Value menu — substring + case-fold**

Type `/config:set kaizen-config backend=ch` and confirm only `keychain` appears.
Type `/config:set kaizen-config backend=KEY` and confirm `keychain` still appears.

- [ ] **Step 6: Flag menu — narrows as typed**

Type `/config:set kaizen-config foo=bar --pro` and confirm only `--project` is offered (assuming `--project` is the only matching flag; `/config:set` does not declare `--reveal`, but `/config:get` does — test there too: `/config:get kaizen-config --rev` → `--reveal`).

- [ ] **Step 7: Empty-query regression — full lists still appear**

Type `/` (just the slash) and confirm every registered command appears.
Type `/config:set ` (with trailing space) and confirm every registered plugin appears.
Type `/config:set kaizen-config ` and confirm every schema field appears.
Type `/config:set kaizen-config backend=` and confirm `env` and `keychain` both appear.

Expected: all menus show their full unfiltered lists when the slot query is empty.

If any step fails, file the issue, do not mark the task complete, and stop. Roll forward with a fix on the relevant plugin before re-deploying.

---

## Notes for the executor

- Bun's test runner doesn't auto-discover sibling test files in arbitrary subdirs — kaizen-config uses files in the plugin root (`slash-completions.test.ts`, `field-rendering.test.ts`); llm-slash-commands uses both root (`arg-completion.test.ts`) and a `test/` subdir (`test/completion.test.ts`). Place new files matching the existing convention for each plugin (root for kaizen-config, root for arg-completion-related tests, `test/` for completion-related tests in llm-slash-commands).
- Don't bump plugin versions in `package.json` — this is a behavior change, not a contract change, and the deploy recipe writes to the same `<plugin>@<version>` install dir.
- Don't touch `llm-contracts`. No types change. Don't redeploy it.
- Commits go straight to `main`. No PRs, no `Co-Authored-By` lines, no `document-and-commit` skill.
- After Task 10, before Task 11, confirm the harness picks up the new bundles by exiting and re-launching `kaizen --harness ...`. The kaizen runtime caches modules — a stale process will show pre-fix behavior.
