import { describe, it, expect } from "bun:test";
import { stringLeaves } from "../string-leaves.ts";

describe("stringLeaves", () => {
  it("returns a single string for a flat object", () => {
    expect(stringLeaves({ command: "ls -la" })).toEqual(["ls -la"]);
  });

  it("collects nested strings in objects and arrays", () => {
    expect(
      stringLeaves({ url: "https://github.com/x", headers: { ua: "x" }, paths: ["/a", "/b"] }),
    ).toEqual(["https://github.com/x", "x", "/a", "/b"]);
  });

  it("returns [] when args has no string leaves", () => {
    expect(stringLeaves({ count: 5, enabled: true, n: null })).toEqual([]);
  });

  it("handles a raw string arg", () => {
    expect(stringLeaves("raw string arg")).toEqual(["raw string arg"]);
  });

  it("ignores non-string primitives at any depth", () => {
    expect(stringLeaves({ a: 1, b: { c: "yes", d: false } })).toEqual(["yes"]);
  });

  it("caps total leaves at the supplied max", () => {
    const big = { items: Array.from({ length: 100 }, (_, i) => `s${i}`) };
    const out = stringLeaves(big, 5);
    expect(out).toEqual(["s0", "s1", "s2", "s3", "s4"]);
  });

  it("does not loop forever on cyclic input", () => {
    const a: any = { name: "a" };
    a.self = a;
    const out = stringLeaves(a);
    expect(out).toEqual(["a"]);
  });

  it("returns [] for null / undefined / non-object primitives", () => {
    expect(stringLeaves(null)).toEqual([]);
    expect(stringLeaves(undefined)).toEqual([]);
    expect(stringLeaves(42)).toEqual([]);
    expect(stringLeaves(true)).toEqual([]);
  });
});
