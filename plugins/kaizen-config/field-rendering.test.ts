import { describe, it, expect } from "bun:test";
import type { FieldSchema } from "llm-contracts/public";
import { formatValue, renderFieldRow, type RenderInputs } from "./field-rendering.ts";

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
