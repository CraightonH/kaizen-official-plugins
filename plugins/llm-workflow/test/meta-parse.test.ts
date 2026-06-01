import { describe, it, expect } from "bun:test";
import { extractMeta } from "../meta-parse.ts";
import { MetaParseError } from "../errors.ts";

describe("extractMeta", () => {
  it("extracts a minimal meta literal", () => {
    const src = `
      export const meta = {
        name: "demo",
        description: "demo workflow"
      };
      phase("X");
      log("hi");
    `;
    const meta = extractMeta(src);
    expect(meta.name).toBe("demo");
    expect(meta.description).toBe("demo workflow");
  });

  it("extracts phases array with nested objects", () => {
    const src = `export const meta = {
      name: "review-changes",
      description: "Review",
      phases: [
        { title: "Scan", detail: "grep test logs" },
        { title: "Fix" }
      ]
    };`;
    const meta = extractMeta(src);
    expect(meta.phases).toEqual([
      { title: "Scan", detail: "grep test logs" },
      { title: "Fix" },
    ]);
  });

  it("rejects spread", () => {
    const src = `export const meta = { ...other, name: "x", description: "y" };`;
    expect(() => extractMeta(src)).toThrow(MetaParseError);
  });

  it("rejects template-string interpolation", () => {
    const src = "export const meta = { name: `dyn-${1}`, description: \"d\" };";
    expect(() => extractMeta(src)).toThrow(MetaParseError);
  });

  it("rejects identifier reference for value", () => {
    const src = `const N = "x"; export const meta = { name: N, description: "d" };`;
    expect(() => extractMeta(src)).toThrow(MetaParseError);
  });

  it("rejects missing required keys", () => {
    const src = `export const meta = { name: "x" };`;
    expect(() => extractMeta(src)).toThrow(MetaParseError);
  });

  it("rejects function call inside meta", () => {
    const src = `export const meta = { name: fn(), description: "d" };`;
    expect(() => extractMeta(src)).toThrow(MetaParseError);
  });

  it("rejects when no export const meta present", () => {
    const src = `phase("x"); log("y");`;
    expect(() => extractMeta(src)).toThrow(MetaParseError);
  });
});
