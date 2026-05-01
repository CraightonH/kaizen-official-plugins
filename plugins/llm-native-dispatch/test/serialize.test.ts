// plugins/llm-native-dispatch/test/serialize.test.ts
import { describe, it, expect } from "bun:test";
import { serializeResult, serializeError } from "../serialize.ts";

describe("serializeResult", () => {
  it("string passes through", () => {
    expect(serializeResult("hi")).toEqual({ content: "hi", circular: false });
  });
  it("undefined → empty string", () => {
    expect(serializeResult(undefined)).toEqual({ content: "", circular: false });
  });
  it("null → empty string", () => {
    expect(serializeResult(null)).toEqual({ content: "", circular: false });
  });
  it("number → JSON-stringified", () => {
    expect(serializeResult(42)).toEqual({ content: "42", circular: false });
  });
  it("object → JSON-stringified", () => {
    expect(serializeResult({ a: 1 })).toEqual({ content: '{"a":1}', circular: false });
  });
  it("array → JSON-stringified", () => {
    expect(serializeResult([1, 2])).toEqual({ content: "[1,2]", circular: false });
  });
  it("circular structure → String() fallback with circular: true", () => {
    const o: any = { a: 1 };
    o.self = o;
    const out = serializeResult(o);
    expect(out.circular).toBe(true);
    expect(out.content).toBe(String(o));
  });
});

describe("serializeError", () => {
  it("wraps message in { error }", () => {
    expect(serializeError("boom")).toBe('{"error":"boom"}');
  });
});
