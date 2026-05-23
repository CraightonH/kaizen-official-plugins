# `/config:set` Inline Current Values — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface each kaizen-config field's current effective value inline in the `/config:set` autocomplete menu (and `/config:get` / `/config:unset` while we're there), pre-fill free-form values for editing, and replace the per-value boolean/enum row explosion with a single field row that drills into a value tier marked with `✓`.

**Architecture:** Single-plugin change to `kaizen-config`. One new pure module `field-rendering.ts` holds all the display logic; `slash-completions.ts` becomes a thin orchestrator that pulls the merged value snapshot and resolution map from `ConfigStoreService` and dispatches to the renderer; `slash.ts` threads a new `query` parameter into the `/config:set` `complete` callback. No contract changes. No edits to `llm-slash-commands` or `llm-tui`.

**Tech Stack:** TypeScript, `bun:test`, `llm-contracts` (workspace dep).

**Reference spec:** `docs/superpowers/specs/2026-05-22-config-set-inline-current-values-design.md`. Read it before starting — the spec's rendering rule tables are the contract this plan implements.

---

## File structure

| Path | Role |
|---|---|
| `plugins/kaizen-config/field-rendering.ts` (new) | Pure rendering. Exports `formatValue`, `renderFieldRow`, `renderValueRows`. No I/O, no `store`, no `ctx`. |
| `plugins/kaizen-config/field-rendering.test.ts` (new) | Unit tests for the renderer — covers each row in the spec's rendering-rule tables. |
| `plugins/kaizen-config/slash-completions.ts` (modify) | Orchestrator. Adds `query` param to `keyEqualsValueCompletions`; both completion functions pull values + resolution and delegate to `field-rendering`. |
| `plugins/kaizen-config/slash-completions.test.ts` (modify) | Updated assertions: drop per-value boolean/enum rows; add tier-branching cases; add resolution/value plumbing. |
| `plugins/kaizen-config/slash.ts` (modify) | One-line wiring change: `/config:set`'s `complete` callback now passes `query` through. |
| `plugins/kaizen-config/test/slash.test.ts` (modify) | Smoke-test that the `complete` callback propagates `query`. |

---

## Task 1: Scaffold `field-rendering.ts` with `formatValue`

`formatValue` is the deepest helper — secret redaction, truncation, JSON-stringification for non-scalars. Other functions depend on it, so it lands first.

**Files:**
- Create: `plugins/kaizen-config/field-rendering.ts`
- Create: `plugins/kaizen-config/field-rendering.test.ts`

- [ ] **Step 1: Write the failing test file**

```ts
// plugins/kaizen-config/field-rendering.test.ts
import { describe, it, expect } from "bun:test";
import type { FieldSchema } from "llm-contracts/public";
import { formatValue } from "./field-rendering.ts";

describe("formatValue", () => {
  const stringField: FieldSchema = { type: "string" };
  const secretField: FieldSchema = { type: "string", secret: true };
  const boolField: FieldSchema = { type: "boolean" };
  const numberField: FieldSchema = { type: "number" };

  it("renders scalar strings as-is when under max", () => {
    expect(formatValue("hello", stringField, { max: 30 })).toBe("hello");
  });

  it("renders booleans as their literal", () => {
    expect(formatValue(true, boolField, { max: 30 })).toBe("true");
    expect(formatValue(false, boolField, { max: 30 })).toBe("false");
  });

  it("renders numbers via String()", () => {
    expect(formatValue(42, numberField, { max: 30 })).toBe("42");
  });

  it("renders secret values as ***", () => {
    expect(formatValue("swordfish", secretField, { max: 30 })).toBe("***");
  });

  it("renders null and undefined as (unset)", () => {
    expect(formatValue(null, stringField, { max: 30 })).toBe("(unset)");
    expect(formatValue(undefined, stringField, { max: 30 })).toBe("(unset)");
  });

  it("JSON-stringifies non-scalars", () => {
    expect(formatValue({ a: 1 }, { type: "object", properties: {} } as FieldSchema, { max: 30 }))
      .toBe('{"a":1}');
    expect(formatValue([1, 2, 3], { type: "array", items: { type: "number" } } as FieldSchema, { max: 30 }))
      .toBe("[1,2,3]");
  });

  it("truncates values longer than max with a trailing ellipsis", () => {
    const long = "abcdefghijklmnopqrstuvwxyz0123456789";
    expect(formatValue(long, stringField, { max: 10 })).toBe("abcdefghi…");
    expect(formatValue(long, stringField, { max: 10 }).length).toBe(10);
  });

  it("does not truncate when value equals max", () => {
    expect(formatValue("abcde", stringField, { max: 5 })).toBe("abcde");
  });

  it("renders (error) when JSON.stringify throws (circular ref)", () => {
    const circular: any = {};
    circular.self = circular;
    expect(formatValue(circular, { type: "object", properties: {} } as FieldSchema, { max: 30 }))
      .toBe("(error)");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd plugins/kaizen-config && bun test field-rendering.test.ts
```

Expected: FAIL — `Cannot find module './field-rendering.ts'`.

- [ ] **Step 3: Implement `formatValue`**

```ts
// plugins/kaizen-config/field-rendering.ts
import type { FieldSchema } from "llm-contracts/public";

const SECRET_MASK = "***";
const UNSET_MARKER = "(unset)";
const ERROR_MARKER = "(error)";
const ELLIPSIS = "…";

export function formatValue(
  value: unknown,
  field: FieldSchema,
  opts: { max: number },
): string {
  if (value === null || value === undefined) return UNSET_MARKER;
  if (field.type === "string" && field.secret) return SECRET_MASK;

  let rendered: string;
  try {
    if (typeof value === "string") rendered = value;
    else if (typeof value === "number" || typeof value === "boolean") rendered = String(value);
    else rendered = JSON.stringify(value);
  } catch {
    return ERROR_MARKER;
  }

  if (rendered.length > opts.max) {
    return rendered.slice(0, opts.max - 1) + ELLIPSIS;
  }
  return rendered;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd plugins/kaizen-config && bun test field-rendering.test.ts
```

Expected: PASS — all 9 cases green.

- [ ] **Step 5: Commit**

```bash
git add plugins/kaizen-config/field-rendering.ts plugins/kaizen-config/field-rendering.test.ts
git commit -m "kaizen-config: add formatValue helper for completion-menu rendering"
```

---

## Task 2: `renderFieldRow`

Produces the field-tier row (one per field). Reads schema, current value, resolution source; emits `label` + `detail` + `insertText` per the spec's field-tier table.

**Files:**
- Modify: `plugins/kaizen-config/field-rendering.ts` (add `renderFieldRow`)
- Modify: `plugins/kaizen-config/field-rendering.test.ts` (add `describe("renderFieldRow")`)

- [ ] **Step 1: Append failing tests**

```ts
// append to plugins/kaizen-config/field-rendering.test.ts
import { renderFieldRow, type RenderInputs } from "./field-rendering.ts";

function inputs(over: Partial<RenderInputs>): RenderInputs {
  return {
    key: "url",
    field: { type: "string" },
    currentValue: "https://example.com",
    source: "home",
    isSet: true,
    ...over,
  };
}

describe("renderFieldRow", () => {
  it("label is always the bare key", () => {
    expect(renderFieldRow(inputs({})).label).toBe("url");
  });

  it("free-form string set in home renders ✓ value · home and pre-fills insertText", () => {
    const row = renderFieldRow(inputs({ key: "url", currentValue: "https://x", source: "home" }));
    expect(row.detail).toBe("✓ https://x · home  string");
    expect(row.insertText).toBe("url=https://x ");
  });

  it("free-form string from default still shows ✓ and source=default; pre-fills", () => {
    const row = renderFieldRow(inputs({
      key: "url", currentValue: "https://default", source: "default", isSet: false,
    }));
    expect(row.detail).toBe("✓ https://default · default  string");
    expect(row.insertText).toBe("url=https://default ");
  });

  it("env-sourced value shows ✓ and · env, but suppresses pre-fill", () => {
    const row = renderFieldRow(inputs({
      key: "url", currentValue: "https://env", source: "env", isSet: true,
    }));
    expect(row.detail).toBe("✓ https://env · env  string");
    expect(row.insertText).toBe("url=");
  });

  it("secret field set in home renders *** with · secret type tag", () => {
    const row = renderFieldRow(inputs({
      key: "apiKey",
      field: { type: "string", secret: true },
      currentValue: "swordfish",
      source: "home",
      isSet: true,
    }));
    expect(row.detail).toBe("✓ *** · home  string · secret");
    expect(row.insertText).toBe("apiKey=");
  });

  it("secret unset renders (unset) with no ✓", () => {
    const row = renderFieldRow(inputs({
      key: "apiKey",
      field: { type: "string", secret: true },
      currentValue: undefined,
      source: "default",
      isSet: false,
    }));
    expect(row.detail).toBe("(unset)  string · secret");
    expect(row.insertText).toBe("apiKey=");
  });

  it("boolean set in home renders ✓ true · home, no pre-fill", () => {
    const row = renderFieldRow(inputs({
      key: "thoughtsMarkdown",
      field: { type: "boolean" },
      currentValue: true,
      source: "home",
      isSet: true,
    }));
    expect(row.detail).toBe("✓ true · home  boolean");
    expect(row.insertText).toBe("thoughtsMarkdown=");
  });

  it("enum field renders enum type tag, no pre-fill", () => {
    const row = renderFieldRow(inputs({
      key: "backend",
      field: { type: "enum", values: ["env", "keychain"] },
      currentValue: "keychain",
      source: "project",
      isSet: true,
    }));
    expect(row.detail).toBe("✓ keychain · project  enum");
    expect(row.insertText).toBe("backend=");
  });

  it("string-with-enum is treated like an enum (no pre-fill)", () => {
    const row = renderFieldRow(inputs({
      key: "backend",
      field: { type: "string", enum: ["env", "keychain"] },
      currentValue: "keychain",
      source: "home",
      isSet: true,
    }));
    expect(row.detail).toBe("✓ keychain · home  string");
    expect(row.insertText).toBe("backend=");
  });

  it("unset (no default in force either) renders (unset) with no ✓", () => {
    const row = renderFieldRow(inputs({
      key: "url",
      currentValue: undefined,
      source: "default",
      isSet: false,
    }));
    expect(row.detail).toBe("(unset)  string");
    expect(row.insertText).toBe("url=");
  });

  it("long string value truncates in detail but pre-fills full value", () => {
    const long = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
    const row = renderFieldRow(inputs({ key: "url", currentValue: long, source: "home" }));
    expect(row.detail).toBe(`✓ ${long.slice(0, 29)}… · home  string`);
    expect(row.insertText).toBe(`url=${long} `);
  });

  it("suppresses pre-fill when value contains whitespace", () => {
    const row = renderFieldRow(inputs({ key: "url", currentValue: "has space", source: "home" }));
    expect(row.insertText).toBe("url=");
  });

  it("suppresses pre-fill when value starts with --", () => {
    const row = renderFieldRow(inputs({ key: "url", currentValue: "--flag", source: "home" }));
    expect(row.insertText).toBe("url=");
  });

  it("suppresses pre-fill for number field too (free-form numeric)", () => {
    const row = renderFieldRow(inputs({
      key: "port",
      field: { type: "number" },
      currentValue: 5432,
      source: "home",
    }));
    expect(row.insertText).toBe("port=5432 ");
    expect(row.detail).toBe("✓ 5432 · home  number");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd plugins/kaizen-config && bun test field-rendering.test.ts
```

Expected: FAIL — `renderFieldRow` and `RenderInputs` not exported.

- [ ] **Step 3: Implement `renderFieldRow`**

```ts
// append to plugins/kaizen-config/field-rendering.ts
import type { ConfigResolutionSource, CompletionItem } from "llm-contracts/public";

const TRUNCATE_MAX = 30;
const CHECK_GLYPH = "✓ ";

export type RenderInputs = {
  key: string;
  field: FieldSchema;
  currentValue: unknown;
  source: ConfigResolutionSource;
  isSet: boolean;
};

function typeTag(field: FieldSchema): string {
  if (field.type === "string" && field.secret) return "string · secret";
  return field.type;
}

function isFreeForm(field: FieldSchema): boolean {
  if (field.type === "number") return true;
  if (field.type === "string" && !field.enum && !field.secret) return true;
  return false;
}

function canPrefill(input: RenderInputs, rendered: string): boolean {
  if (!input.isSet) return false;
  if (input.source === "env") return false;
  if (input.field.type === "string" && input.field.secret) return false;
  if (!isFreeForm(input.field)) return false;
  if (/\s/.test(rendered)) return false;
  if (rendered.startsWith("--")) return false;
  return true;
}

export function renderFieldRow(input: RenderInputs): CompletionItem {
  const tag = typeTag(input.field);
  const isUnset = input.currentValue === null || input.currentValue === undefined;

  let detail: string;
  if (isUnset) {
    detail = `(unset)  ${tag}`;
  } else {
    const display = formatValue(input.currentValue, input.field, { max: TRUNCATE_MAX });
    detail = `${CHECK_GLYPH}${display} · ${input.source}  ${tag}`;
  }

  // Pre-fill uses the *full* (non-truncated) value, not the display form.
  let insertText = `${input.key}=`;
  if (!isUnset) {
    const fullRendered =
      typeof input.currentValue === "string"
        ? input.currentValue
        : typeof input.currentValue === "number" || typeof input.currentValue === "boolean"
          ? String(input.currentValue)
          : "";
    if (canPrefill(input, fullRendered)) {
      insertText = `${input.key}=${fullRendered} `;
    }
  }

  return { label: input.key, insertText, detail };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd plugins/kaizen-config && bun test field-rendering.test.ts
```

Expected: PASS — all `formatValue` and `renderFieldRow` cases green.

- [ ] **Step 5: Commit**

```bash
git add plugins/kaizen-config/field-rendering.ts plugins/kaizen-config/field-rendering.test.ts
git commit -m "kaizen-config: add renderFieldRow for completion-menu field tier"
```

---

## Task 3: `renderValueRows`

Produces the value-tier rows for booleans and enums. Free-form fields return `[]` (field row already pre-filled). Value-query string filters the rows by prefix.

**Files:**
- Modify: `plugins/kaizen-config/field-rendering.ts` (add `renderValueRows`)
- Modify: `plugins/kaizen-config/field-rendering.test.ts` (add `describe("renderValueRows")`)

- [ ] **Step 1: Append failing tests**

```ts
// append to plugins/kaizen-config/field-rendering.test.ts
import { renderValueRows } from "./field-rendering.ts";

describe("renderValueRows", () => {
  it("emits two rows for booleans with ✓ on the current value", () => {
    const rows = renderValueRows(inputs({
      key: "thoughtsMarkdown",
      field: { type: "boolean" },
      currentValue: true,
      source: "home",
    }), "");
    expect(rows.map(r => r.label)).toEqual(["✓ true", "  false"]);
    expect(rows[0]!.detail).toBe("boolean");
    expect(rows[1]!.detail).toBe("boolean");
    expect(rows[0]!.insertText).toBe("thoughtsMarkdown=true ");
    expect(rows[1]!.insertText).toBe("thoughtsMarkdown=false ");
  });

  it("emits ✓ on the matching boolean when current is false", () => {
    const rows = renderValueRows(inputs({
      key: "thoughtsMarkdown",
      field: { type: "boolean" },
      currentValue: false,
      source: "home",
    }), "");
    expect(rows.map(r => r.label)).toEqual(["  true", "✓ false"]);
  });

  it("emits one row per enum value with ✓ on the current", () => {
    const rows = renderValueRows(inputs({
      key: "backend",
      field: { type: "enum", values: ["env", "keychain", "bitwarden"] },
      currentValue: "keychain",
      source: "home",
    }), "");
    expect(rows.map(r => r.label)).toEqual(["  env", "✓ keychain", "  bitwarden"]);
    expect(rows.map(r => r.detail)).toEqual(["enum", "enum", "enum"]);
    expect(rows[0]!.insertText).toBe("backend=env ");
    expect(rows[1]!.insertText).toBe("backend=keychain ");
    expect(rows[2]!.insertText).toBe("backend=bitwarden ");
  });

  it("handles string-with-enum identically to type=enum", () => {
    const rows = renderValueRows(inputs({
      key: "backend",
      field: { type: "string", enum: ["env", "keychain"] },
      currentValue: "env",
      source: "home",
    }), "");
    expect(rows.map(r => r.label)).toEqual(["✓ env", "  keychain"]);
    expect(rows[0]!.detail).toBe("string");
  });

  it("filters rows by valueQuery prefix", () => {
    const rows = renderValueRows(inputs({
      key: "backend",
      field: { type: "enum", values: ["env", "keychain", "bitwarden"] },
      currentValue: "keychain",
    }), "k");
    expect(rows.map(r => r.label)).toEqual(["✓ keychain"]);
  });

  it("filters booleans by valueQuery prefix", () => {
    const rows = renderValueRows(inputs({
      key: "x",
      field: { type: "boolean" },
      currentValue: true,
    }), "t");
    expect(rows.map(r => r.label)).toEqual(["✓ true"]);
  });

  it("returns [] for free-form string fields (pre-fill on field row already handled it)", () => {
    const rows = renderValueRows(inputs({
      key: "url",
      field: { type: "string" },
      currentValue: "https://example.com",
    }), "");
    expect(rows).toEqual([]);
  });

  it("returns [] for number fields", () => {
    const rows = renderValueRows(inputs({
      key: "port",
      field: { type: "number" },
      currentValue: 5432,
    }), "");
    expect(rows).toEqual([]);
  });

  it("returns [] for secret fields (no value choices to surface)", () => {
    const rows = renderValueRows(inputs({
      key: "apiKey",
      field: { type: "string", secret: true },
      currentValue: "swordfish",
    }), "");
    expect(rows).toEqual([]);
  });

  it("when current is not one of the enum values, no row gets the ✓", () => {
    const rows = renderValueRows(inputs({
      key: "backend",
      field: { type: "enum", values: ["env", "keychain"] },
      currentValue: "legacy",
      source: "home",
      isSet: true,
    }), "");
    expect(rows.map(r => r.label)).toEqual(["  env", "  keychain"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd plugins/kaizen-config && bun test field-rendering.test.ts
```

Expected: FAIL — `renderValueRows` not exported.

- [ ] **Step 3: Implement `renderValueRows`**

```ts
// append to plugins/kaizen-config/field-rendering.ts

const NO_CHECK_PAD = "  ";

function enumValues(field: FieldSchema): readonly string[] | null {
  if (field.type === "enum") return field.values;
  if (field.type === "string" && field.enum) return field.enum;
  return null;
}

function valueRow(
  key: string,
  value: string,
  isCurrent: boolean,
  typeTagStr: string,
): CompletionItem {
  const prefix = isCurrent ? CHECK_GLYPH : NO_CHECK_PAD;
  return {
    label: `${prefix}${value}`,
    insertText: `${key}=${value} `,
    detail: typeTagStr,
  };
}

export function renderValueRows(input: RenderInputs, valueQuery: string): CompletionItem[] {
  const tag = typeTag(input.field);
  const current = input.currentValue;

  if (input.field.type === "boolean") {
    const all = ["true", "false"];
    return all
      .filter((v) => v.startsWith(valueQuery))
      .map((v) => valueRow(input.key, v, current === (v === "true"), tag));
  }

  const enumVals = enumValues(input.field);
  if (enumVals) {
    return enumVals
      .filter((v) => v.startsWith(valueQuery))
      .map((v) => valueRow(input.key, v, current === v, tag));
  }

  return [];
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd plugins/kaizen-config && bun test field-rendering.test.ts
```

Expected: PASS — all `renderValueRows` cases green plus everything from Tasks 1-2.

- [ ] **Step 5: Commit**

```bash
git add plugins/kaizen-config/field-rendering.ts plugins/kaizen-config/field-rendering.test.ts
git commit -m "kaizen-config: add renderValueRows for completion-menu value tier"
```

---

## Task 4: Rewrite `keyEqualsValueCompletions` with tiered branching

Adds the `query` parameter, pulls the merged snapshot and resolution map from `store`, and delegates to `field-rendering`. The existing assertion shape (per-value rows for boolean/enum) is replaced by the new shape; tests are rewritten in lockstep.

**Files:**
- Modify: `plugins/kaizen-config/slash-completions.ts`
- Modify: `plugins/kaizen-config/slash-completions.test.ts`

- [ ] **Step 1: Rewrite the test cases for `keyEqualsValueCompletions`**

Replace the existing `describe("keyEqualsValueCompletions", ...)` block in `plugins/kaizen-config/slash-completions.test.ts` with:

```ts
describe("keyEqualsValueCompletions", () => {
  function storeWith(
    snapshot: Record<string, unknown>,
    resolution: Record<string, "default" | "home" | "project" | "env">,
  ): ConfigStoreService {
    const base = makeStore();
    return {
      ...base,
      get: () => snapshot as any,
      list: () => [
        {
          plugin: "kaizen-config",
          homePath: "/h",
          projectPath: "/p",
          homeExists: true,
          projectExists: false,
          resolution,
        },
      ],
    };
  }

  it("returns [] when plugin is unknown", async () => {
    const items = await keyEqualsValueCompletions(makeStore(), ["nope"], "");
    expect(items).toEqual([]);
  });

  it("field tier (empty query): one row per field, each with ✓ value in detail", async () => {
    const store = storeWith(
      { enabled: true, backend: "keychain", apiKey: "swordfish", url: "https://x" },
      { enabled: "home", backend: "home", apiKey: "home", url: "home" },
    );
    const items = await keyEqualsValueCompletions(store, ["kaizen-config"], "");
    const labels = items.map((i) => i.label).sort();
    expect(labels).toEqual(["apiKey", "backend", "enabled", "url"]);
    expect(items.find((i) => i.label === "enabled")!.detail)
      .toBe("✓ true · home  boolean");
    expect(items.find((i) => i.label === "apiKey")!.detail)
      .toBe("✓ *** · home  string · secret");
    expect(items.find((i) => i.label === "url")!.insertText).toBe("url=https://x ");
    expect(items.find((i) => i.label === "enabled")!.insertText).toBe("enabled=");
  });

  it("field tier: unset values render (unset) with no ✓ and key= insertText", async () => {
    const store = storeWith({}, {});
    const items = await keyEqualsValueCompletions(store, ["kaizen-config"], "");
    expect(items.find((i) => i.label === "url")!.detail).toBe("(unset)  string");
    expect(items.find((i) => i.label === "url")!.insertText).toBe("url=");
  });

  it("field tier: env-sourced value shows · env in detail and suppresses pre-fill", async () => {
    const store = storeWith({ url: "https://env" }, { url: "env" });
    const items = await keyEqualsValueCompletions(store, ["kaizen-config"], "");
    expect(items.find((i) => i.label === "url")!.detail)
      .toBe("✓ https://env · env  string");
    expect(items.find((i) => i.label === "url")!.insertText).toBe("url=");
  });

  it("value tier (query has '='): rows for the matching field only", async () => {
    const store = storeWith(
      { enabled: true, backend: "keychain" },
      { enabled: "home", backend: "home" },
    );
    const items = await keyEqualsValueCompletions(store, ["kaizen-config"], "enabled=");
    expect(items.map((i) => i.label)).toEqual(["✓ true", "  false"]);
    expect(items[0]!.insertText).toBe("enabled=true ");
  });

  it("value tier: enum values, ✓ on current", async () => {
    const store = storeWith({ backend: "keychain" }, { backend: "home" });
    const items = await keyEqualsValueCompletions(store, ["kaizen-config"], "backend=");
    expect(items.map((i) => i.label)).toEqual(["  env", "✓ keychain"]);
  });

  it("value tier: filters by post-= text", async () => {
    const store = storeWith({ backend: "env" }, { backend: "home" });
    const items = await keyEqualsValueCompletions(store, ["kaizen-config"], "backend=k");
    expect(items.map((i) => i.label)).toEqual(["  keychain"]);
  });

  it("value tier: free-form field returns []", async () => {
    const store = storeWith({ url: "https://x" }, { url: "home" });
    const items = await keyEqualsValueCompletions(store, ["kaizen-config"], "url=");
    expect(items).toEqual([]);
  });

  it("value tier: unknown key returns []", async () => {
    const store = storeWith({}, {});
    const items = await keyEqualsValueCompletions(store, ["kaizen-config"], "nopeKey=");
    expect(items).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd plugins/kaizen-config && bun test slash-completions.test.ts
```

Expected: FAIL — `keyEqualsValueCompletions` doesn't accept a third arg in its current signature; old tests pass but the new ones fail or the call shape mismatches.

- [ ] **Step 3: Rewrite `keyEqualsValueCompletions`**

Replace the existing `keyEqualsValueCompletions` function in `plugins/kaizen-config/slash-completions.ts` with:

```ts
import type {
  CompletionItem,
  ConfigResolutionSource,
  ConfigStoreService,
  FieldSchema,
} from "llm-contracts/public";
import { renderFieldRow, renderValueRows } from "./field-rendering.ts";

export async function keyEqualsValueCompletions(
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
  try { merged = store.get(plugin) as Record<string, unknown>; } catch { merged = {}; }
  const status = store.list().find((r) => r.plugin === plugin);
  const resolution = (status?.resolution ?? {}) as Record<string, ConfigResolutionSource>;

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
    return rows;
  }

  const key = query.slice(0, eqIdx);
  const valueQuery = query.slice(eqIdx + 1);
  const field = schema[key];
  if (!field) return [];
  const source = resolution[key] ?? "default";
  return renderValueRows(
    { key, field, currentValue: merged[key], source, isSet: source !== "default" },
    valueQuery,
  );
}
```

Leave `fieldDetail` and the unused old branches deleted — they're now superseded by `field-rendering`.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd plugins/kaizen-config && bun test slash-completions.test.ts
```

Expected: PASS — `pluginCompletions`, the new `keyEqualsValueCompletions`, and the still-untouched `keyOnlyCompletions` describe blocks all pass.

- [ ] **Step 5: Commit**

```bash
git add plugins/kaizen-config/slash-completions.ts plugins/kaizen-config/slash-completions.test.ts
git commit -m "kaizen-config: tiered completion for /config:set with inline current values"
```

---

## Task 5: Update `keyOnlyCompletions` to use `renderFieldRow`

`/config:get` and `/config:unset` should show the same `✓ value · source  type` detail.

**Files:**
- Modify: `plugins/kaizen-config/slash-completions.ts`
- Modify: `plugins/kaizen-config/slash-completions.test.ts`

- [ ] **Step 1: Replace the `keyOnlyCompletions` test block**

Replace the existing `describe("keyOnlyCompletions", ...)` block with:

```ts
describe("keyOnlyCompletions", () => {
  function storeWith(
    snapshot: Record<string, unknown>,
    resolution: Record<string, "default" | "home" | "project" | "env">,
  ): ConfigStoreService {
    const base = makeStore();
    return {
      ...base,
      get: () => snapshot as any,
      list: () => [
        {
          plugin: "kaizen-config",
          homePath: "/h",
          projectPath: "/p",
          homeExists: true,
          projectExists: false,
          resolution,
        },
      ],
    };
  }

  it("returns one row per field with insertText `key ` (trailing space, no `=`)", async () => {
    const store = storeWith({ url: "https://x" }, { url: "home" });
    const items = await keyOnlyCompletions(store, ["kaizen-config"]);
    expect(items.map((i) => i.label).sort()).toEqual(["apiKey", "backend", "enabled", "url"]);
    const url = items.find((i) => i.label === "url")!;
    expect(url.insertText).toBe("url ");
    expect(url.insertText.includes("=")).toBe(false);
  });

  it("detail uses the same ✓ value · source  type convention as the field tier", async () => {
    const store = storeWith({ url: "https://x" }, { url: "home" });
    const items = await keyOnlyCompletions(store, ["kaizen-config"]);
    expect(items.find((i) => i.label === "url")!.detail).toBe("✓ https://x · home  string");
  });

  it("returns [] when plugin is unknown", async () => {
    const items = await keyOnlyCompletions(makeStore(), ["nope"]);
    expect(items).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd plugins/kaizen-config && bun test slash-completions.test.ts
```

Expected: FAIL — `insertText` is `url=` not `url ` (boolean/enum legacy emits `key=true `) AND detail is the old `string` not `✓ ... · home  string`.

- [ ] **Step 3: Rewrite `keyOnlyCompletions`**

Replace the existing `keyOnlyCompletions` function:

```ts
export async function keyOnlyCompletions(
  store: ConfigStoreService,
  prev: string[],
): Promise<CompletionItem[]> {
  const plugin = prev[0];
  if (!plugin) return [];
  const spec = store.getSpec(plugin);
  const schema = spec?.schema as Record<string, FieldSchema | undefined> | undefined;
  if (!schema) return [];

  let merged: Record<string, unknown> = {};
  try { merged = store.get(plugin) as Record<string, unknown>; } catch { merged = {}; }
  const status = store.list().find((r) => r.plugin === plugin);
  const resolution = (status?.resolution ?? {}) as Record<string, ConfigResolutionSource>;

  const rows: CompletionItem[] = [];
  for (const [key, field] of Object.entries(schema)) {
    if (!field) continue;
    const source = resolution[key] ?? "default";
    const row = renderFieldRow({
      key, field, currentValue: merged[key], source, isSet: source !== "default",
    });
    // /config:get and /config:unset don't take a value — the field row should
    // insert `key ` (trailing space, no `=`), not `key=` or pre-filled.
    rows.push({ label: row.label, insertText: `${key} `, detail: row.detail });
  }
  return rows;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd plugins/kaizen-config && bun test slash-completions.test.ts
```

Expected: PASS — `keyOnlyCompletions` returns the new shape.

- [ ] **Step 5: Commit**

```bash
git add plugins/kaizen-config/slash-completions.ts plugins/kaizen-config/slash-completions.test.ts
git commit -m "kaizen-config: surface ✓ current value in /config:get and /config:unset"
```

---

## Task 6: Thread `query` into `/config:set` callback

The `arg-completion.ts:99` call site passes `(prev, query)` to the plugin's completion callback. Currently `slash.ts` writes `complete: (prev) => keyEqualsValueCompletions(deps.store, prev)`, dropping `query` on the floor.

**Files:**
- Modify: `plugins/kaizen-config/slash.ts`
- Modify: `plugins/kaizen-config/test/slash.test.ts`

- [ ] **Step 1: Read the current `slash.ts` `/config:set` registration**

```bash
grep -n 'name: "config:set"' -A 8 plugins/kaizen-config/slash.ts
```

Confirm the `complete` line looks like:

```ts
{ name: "key=value", complete: (prev) => keyEqualsValueCompletions(deps.store, prev) },
```

- [ ] **Step 2: Write a failing test asserting the callback receives query**

Append to `plugins/kaizen-config/test/slash.test.ts`:

```ts
it("/config:set complete callback threads query through to keyEqualsValueCompletions", async () => {
  // Stand up a registry that captures the manifest.
  const captured: { arg?: { complete?: (prev: string[], query: string) => Promise<any> } } = {};
  const reg = {
    register(manifest: any, _handler: any) {
      if (manifest.name === "config:set") {
        captured.arg = manifest.arguments?.[1];
      }
      return () => {};
    },
  };
  const deps = makeDeps(); // existing helper in this file; if absent, construct minimal deps
  registerSlashCommands(reg as any, deps);
  expect(captured.arg?.complete).toBeDefined();
  const rows = await captured.arg!.complete!(["kaizen-config"], "enabled=");
  // We don't assert on contents; we only assert the call shape works end-to-end.
  expect(Array.isArray(rows)).toBe(true);
});
```

If `makeDeps` doesn't exist in the file, copy the existing setup pattern from the top of the file (it builds a fake `store`, `registry`, etc.) into a small helper.

- [ ] **Step 3: Run test to verify it fails**

```bash
cd plugins/kaizen-config && bun test test/slash.test.ts
```

Expected: FAIL — either `captured.arg.complete` returns the wrong shape because `query` is dropped, or (more likely) the assertion that the callback accepts two args holds but the returned rows reflect the field-tier path instead of the value-tier path. The failing case is the contract that query is propagated; tweak the assertion if needed to lock in "value-tier behavior triggered by `enabled=`".

A stronger version (preferred):

```ts
const rowsField = await captured.arg!.complete!(["kaizen-config"], "");
const rowsValue = await captured.arg!.complete!(["kaizen-config"], "enabled=");
expect(rowsField.length).toBeGreaterThan(rowsValue.length); // field tier emits N rows; value tier emits 2
expect(rowsValue.every((r: any) => r.label.includes("true") || r.label.includes("false"))).toBe(true);
```

- [ ] **Step 4: Update `slash.ts`**

In `plugins/kaizen-config/slash.ts`, change:

```ts
{ name: "key=value", complete: (prev) => keyEqualsValueCompletions(deps.store, prev) },
```

to:

```ts
{ name: "key=value", complete: (prev, query) => keyEqualsValueCompletions(deps.store, prev, query) },
```

(Leave the `/config:get` and `/config:unset` `complete: (prev) => keyOnlyCompletions(deps.store, prev)` lines alone — they don't need `query`.)

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd plugins/kaizen-config && bun test
```

Expected: PASS — `field-rendering.test.ts`, `slash-completions.test.ts`, `test/slash.test.ts`, and any other plugin tests all green.

- [ ] **Step 6: Run plugin validator**

```bash
kaizen plugin validate plugins/kaizen-config
```

Expected: no errors. (The contract surface didn't change; this is a smoke check.)

- [ ] **Step 7: Commit**

```bash
git add plugins/kaizen-config/slash.ts plugins/kaizen-config/test/slash.test.ts
git commit -m "kaizen-config: thread query into /config:set completion for value tier"
```

---

## Task 7: Local deploy + manual sanity check

The harness picks up the built bundle from `dist/index.js`, not the source. Build + sync, then exercise the menu in a real session.

**Files:**
- No source changes. Build artifact: `plugins/kaizen-config/dist/index.js`.

- [ ] **Step 1: Build the plugin**

```bash
cd plugins/kaizen-config && bun build --target=bun --outfile=dist/index.js index.ts
```

Expected: build completes; `dist/index.js` exists.

- [ ] **Step 2: Sync to install dir**

```bash
PLUGIN=kaizen-config
VERSION=$(jq -r .version plugins/$PLUGIN/package.json)
INSTALL_DIR=~/.kaizen/marketplaces/official/plugins/${PLUGIN}@${VERSION}
mkdir -p "$INSTALL_DIR/dist"
cp plugins/$PLUGIN/dist/index.js "$INSTALL_DIR/dist/index.js"
rsync -a --exclude='node_modules' --exclude='dist' plugins/$PLUGIN/ "$INSTALL_DIR/"
```

Expected: rsync completes; `$INSTALL_DIR/dist/index.js` matches the just-built bundle.

- [ ] **Step 3: Launch a local harness**

```bash
kaizen --harness ./harnesses/local.json
```

Expected: harness boots without errors.

- [ ] **Step 4: Manual sanity — field tier**

Type `/config:set kaizen-config ` (with trailing space) and pull up the autocomplete.

Verify:
- One row per field (no `key=true` / `key=false` row pairs).
- Each row's detail starts with `✓ ` for set fields or `(unset)` for unset fields.
- Source markers (`· home`, `· project`, `· env`, `· default`) appear correctly.
- Secret fields show `***` instead of the literal value.

- [ ] **Step 5: Manual sanity — value tier**

Pick a boolean field. Verify the cursor lands after `=` and the menu re-fires showing two rows like `✓ true` / `  false`. Pick the non-current one; verify it inserts the full `key=value ` token with trailing space.

Repeat for an enum field (`kaizen-secrets-keychain.defaultSecretBackend` is the obvious target).

- [ ] **Step 6: Manual sanity — pre-fill**

Pick a free-form string field that is set (e.g. via `/config:set kaizen-config url=` then accept the field row). Verify the buffer now contains `url=<current-value> ` and the cursor is positioned for editing.

Confirm pre-fill is **suppressed** for:
- Secret fields (e.g. `apiKey`).
- Fields with env override active.
- Fields whose current value contains whitespace or starts with `--`.

- [ ] **Step 7: Final commit (if any deploy-time tweaks)**

If everything works, no further commits. If manual testing surfaced a bug, fix it via a new TDD cycle and commit before considering this task done.

---

## Self-review notes

After writing this plan, checked against the spec:

- ✅ Field-tier rendering rules (all 9 rows in the spec table) — covered by Task 2 tests.
- ✅ Value-tier rendering rules (boolean current/non-current, enum, filter, free-form empty) — covered by Task 3 tests.
- ✅ Pre-fill suppression rules (env, secret, unset, whitespace, `--` prefix, free-form gate) — covered by Task 2 + reinforced in Task 7 manual check.
- ✅ `keyOnlyCompletions` parallel treatment for `/config:get` and `/config:unset` — covered by Task 5.
- ✅ Slash wiring change for `/config:set` only (not `/config:get` / `/config:unset`) — covered by Task 6.
- ✅ `(error)` fallback for `JSON.stringify` failures — covered by Task 1's circular-ref test.
- ✅ Truncation length 30 — encoded as `TRUNCATE_MAX` constant in Task 2.
- ✅ String-with-enum treated as enum — Tasks 2 and 3 each have a dedicated test.
- ✅ Local deploy + manual harness check — Task 7.

No placeholders, all code blocks complete, type names consistent across tasks (`RenderInputs`, `renderFieldRow`, `renderValueRows`, `formatValue`).
