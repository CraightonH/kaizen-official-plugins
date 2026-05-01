// plugins/llm-native-dispatch/test/args-validation.test.ts
import { describe, it, expect } from "bun:test";
import { isValidToolArgs, malformedArgsMessage } from "../args-validation.ts";

describe("isValidToolArgs", () => {
  it("plain object → true", () => {
    expect(isValidToolArgs({ x: 1 })).toBe(true);
  });
  it("array → true", () => {
    expect(isValidToolArgs([1, 2])).toBe(true);
  });
  it("null → true", () => {
    expect(isValidToolArgs(null)).toBe(true);
  });
  it("string (unparsed body) → false", () => {
    expect(isValidToolArgs('{"x":1}')).toBe(false);
  });
  it("number → false", () => {
    expect(isValidToolArgs(42)).toBe(false);
  });
  it("boolean → false", () => {
    expect(isValidToolArgs(true)).toBe(false);
  });
  it("undefined → false", () => {
    expect(isValidToolArgs(undefined)).toBe(false);
  });
  it("Error instance → false", () => {
    expect(isValidToolArgs(new Error("parse failed"))).toBe(false);
  });
  it("function → false", () => {
    expect(isValidToolArgs(() => {})).toBe(false);
  });
});

describe("malformedArgsMessage", () => {
  it("includes raw stringified value", () => {
    const out = malformedArgsMessage("{not json");
    expect(JSON.parse(out)).toEqual({ error: "malformed arguments JSON from LLM", raw: "{not json" });
  });
  it("stringifies non-string raw values", () => {
    const out = malformedArgsMessage(42);
    expect(JSON.parse(out)).toEqual({ error: "malformed arguments JSON from LLM", raw: "42" });
  });
  it("Error instance raw → message", () => {
    const out = malformedArgsMessage(new Error("boom"));
    expect(JSON.parse(out).raw).toMatch(/boom/);
  });
});
