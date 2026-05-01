import { describe, it, expect } from "bun:test";
import { stringifyReturn, formatResultMessage, truncate } from "../serialize.ts";

describe("stringifyReturn", () => {
  it("undefined → 'undefined'", () => {
    expect(stringifyReturn(undefined)).toBe("undefined");
  });
  it("bigint → \"<n>n\"", () => {
    expect(stringifyReturn(BigInt(7))).toBe("\"7n\"");
  });
  it("circular → [Circular]", () => {
    const a: any = {}; a.self = a;
    expect(stringifyReturn(a)).toContain("[Circular]");
  });
  it("function → [Function]", () => {
    expect(stringifyReturn(() => 1)).toBe("\"[Function]\"");
  });
  it("symbol → [Symbol]", () => {
    expect(stringifyReturn(Symbol("x"))).toBe("\"[Symbol]\"");
  });
  it("plain object → JSON", () => {
    expect(stringifyReturn({ a: 1 })).toBe('{"a":1}');
  });
});

describe("truncate", () => {
  it("returns input under cap unchanged", () => {
    expect(truncate("hello", 100)).toBe("hello");
  });
  it("appends marker when over cap", () => {
    const r = truncate("a".repeat(50), 10);
    expect(r.length).toBeLessThanOrEqual(60);
    expect(r).toMatch(/\[truncated, \d+ more bytes\]/);
  });
});

describe("formatResultMessage", () => {
  it("ok shape", () => {
    const out = formatResultMessage({ ok: true, returnValue: 42, stdout: "hi\n" }, { maxStdoutBytes: 100, maxReturnBytes: 100 });
    expect(out).toContain("[code execution result]");
    expect(out).toContain("exit: ok");
    expect(out).toContain("returned: 42");
    expect(out).toContain("stdout:\nhi");
  });
  it("error shape", () => {
    const out = formatResultMessage({ ok: false, errorName: "TypeError", errorMessage: "boom", stdout: "" }, { maxStdoutBytes: 100, maxReturnBytes: 100 });
    expect(out).toContain("exit: error");
    expect(out).toContain("error: TypeError: boom");
  });
  it("appends ignored-blocks note when provided", () => {
    const out = formatResultMessage({ ok: true, returnValue: 1, stdout: "", ignoredBlocks: 2 }, { maxStdoutBytes: 100, maxReturnBytes: 100 });
    expect(out).toContain("note: 2 additional code block(s) were ignored because the limit is 8");
  });
});
