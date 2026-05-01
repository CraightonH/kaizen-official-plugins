import { describe, it, expect } from "bun:test";
import { wrapCode } from "../wrapper.ts";

describe("wrapCode", () => {
  it("wraps simple expression as return", () => {
    const r = wrapCode("1 + 1");
    expect(r.transpileError).toBeUndefined();
    expect(r.wrapped).toContain("async () =>");
    expect(r.wrapped).toContain("return (1 + 1)");
  });

  it("wraps trailing identifier", () => {
    const r = wrapCode("const x = 5;\nx");
    expect(r.wrapped).toContain("return (x)");
  });

  it("preserves explicit return", () => {
    const r = wrapCode("return 42;");
    expect(r.wrapped).toContain("return 42;");
  });

  it("preserves trailing statement (no rewrite) if not expression", () => {
    const r = wrapCode("const x = 5;\nif (x) { /* */ }");
    expect(r.wrapped).not.toMatch(/return \(if/);
  });

  it("rejects static import", () => {
    const r = wrapCode("import fs from 'node:fs';");
    expect(r.transpileError).toMatch(/import/i);
  });

  it("rejects dynamic import()", () => {
    const r = wrapCode("await import('node:fs');");
    expect(r.transpileError).toMatch(/import/i);
  });

  it("rejects eval(", () => {
    const r = wrapCode("eval('1+1')");
    expect(r.transpileError).toMatch(/eval/i);
  });

  it("rejects new Function(", () => {
    const r = wrapCode("new Function('return 1')()");
    expect(r.transpileError).toMatch(/Function/);
  });

  it("rejects require(", () => {
    const r = wrapCode("require('node:fs')");
    expect(r.transpileError).toMatch(/require/);
  });

  it("syntax error surfaces transpileError", () => {
    const r = wrapCode("const x =");
    expect(r.transpileError).toBeDefined();
  });

  it("empty code wraps to return undefined", () => {
    const r = wrapCode("");
    expect(r.transpileError).toBeUndefined();
    expect(r.wrapped).toMatch(/async\s*\(\s*\)\s*=>/);
  });
});
