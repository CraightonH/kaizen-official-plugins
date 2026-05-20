// plugins/kaizen-config/test/schema.test.ts
import { describe, it, expect } from "bun:test";
import { validate, type ConfigSchema, type FieldSchema } from "../schema.ts";

describe("validate — primitives", () => {
  it("accepts a valid number", () => {
    const r = validate({ n: 5 }, { n: { type: "number", min: 1, max: 10 } });
    expect(r.ok).toBe(true);
  });
  it("rejects a number below min", () => {
    const r = validate({ n: 0 }, { n: { type: "number", min: 1 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0].path).toBe("n");
  });
  it("rejects a non-integer when integer required", () => {
    const r = validate({ n: 1.5 }, { n: { type: "number", integer: true } });
    expect(r.ok).toBe(false);
  });
  it("accepts a valid string with pattern", () => {
    const r = validate({ s: "abc" }, { s: { type: "string", pattern: "^[a-z]+$" } });
    expect(r.ok).toBe(true);
  });
  it("rejects a string failing pattern", () => {
    const r = validate({ s: "ABC" }, { s: { type: "string", pattern: "^[a-z]+$" } });
    expect(r.ok).toBe(false);
  });
  it("accepts an enum value", () => {
    const r = validate({ e: "a" }, { e: { type: "enum", values: ["a", "b"] } });
    expect(r.ok).toBe(true);
  });
  it("rejects an out-of-set enum value", () => {
    const r = validate({ e: "c" }, { e: { type: "enum", values: ["a", "b"] } });
    expect(r.ok).toBe(false);
  });
  it("accepts a boolean", () => {
    const r = validate({ b: true }, { b: { type: "boolean" } });
    expect(r.ok).toBe(true);
  });
  it("rejects a non-boolean for boolean field", () => {
    const r = validate({ b: "true" }, { b: { type: "boolean" } });
    expect(r.ok).toBe(false);
  });
});

describe("validate — arrays", () => {
  it("accepts an array of strings within bounds", () => {
    const r = validate({ a: ["x", "y"] }, { a: { type: "array", items: { type: "string" }, max: 5 } });
    expect(r.ok).toBe(true);
  });
  it("rejects an array exceeding max", () => {
    const r = validate({ a: ["x", "y", "z"] }, { a: { type: "array", items: { type: "string" }, max: 2 } });
    expect(r.ok).toBe(false);
  });
  it("rejects when item fails type", () => {
    const r = validate({ a: ["x", 1] }, { a: { type: "array", items: { type: "string" } } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0].path).toBe("a[1]");
  });
});

describe("validate — objects", () => {
  it("accepts nested object", () => {
    const schema: ConfigSchema<any> = {
      retry: {
        type: "object",
        properties: { max: { type: "number", min: 1 } },
      },
    };
    const r = validate({ retry: { max: 3 } }, schema);
    expect(r.ok).toBe(true);
  });
  it("rejects nested object with bad child", () => {
    const schema: ConfigSchema<any> = {
      retry: {
        type: "object",
        properties: { max: { type: "number", min: 1 } },
      },
    };
    const r = validate({ retry: { max: 0 } }, schema);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0].path).toBe("retry.max");
  });
  it("rejects unknown property when additionalProperties is false", () => {
    const schema: ConfigSchema<any> = {
      retry: {
        type: "object",
        properties: { max: { type: "number" } },
        additionalProperties: false,
      },
    };
    const r = validate({ retry: { max: 1, extra: 9 } }, schema);
    expect(r.ok).toBe(false);
  });
});

describe("validate — unknown top-level keys are allowed by default", () => {
  it("ignores keys not in the schema", () => {
    const r = validate({ known: 1, extra: "x" }, { known: { type: "number" } });
    expect(r.ok).toBe(true);
  });
});
