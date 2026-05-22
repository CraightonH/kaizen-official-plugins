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
