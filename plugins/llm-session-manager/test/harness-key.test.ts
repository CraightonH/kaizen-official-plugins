import { describe, expect, test } from "bun:test";
import { harnessKey } from "../harness-key";

describe("harnessKey", () => {
  test("ref with version strips trailing version", () => {
    expect(harnessKey({ ref: "official/local@0.1.0" })).toBe("official_local");
  });

  test("scoped npm-style refs only strip the trailing version segment", () => {
    expect(harnessKey({ ref: "@scope/name@1.2.3" })).toBe("_scope_name");
  });

  test("local json paths get local_ prefix", () => {
    expect(harnessKey({ jsonPath: "/repo/harnesses/local.json" })).toBe("local_local");
    expect(harnessKey({ jsonPath: "/repo/harnesses/local/kaizen.json" })).toBe("local_local");
  });

  test("missing identity falls back to default", () => {
    expect(harnessKey({})).toBe("default");
  });

  test("ref takes precedence over jsonPath", () => {
    expect(harnessKey({ ref: "official/foo", jsonPath: "/repo/foo.json" })).toBe("official_foo");
  });

  test("rejects refs that collide with local namespace", () => {
    expect(() => harnessKey({ ref: "local" })).toThrow(/reserved local/i);
    expect(() => harnessKey({ ref: "local/foo" })).toThrow(/reserved local/i);
    expect(() => harnessKey({ ref: "local_foo/bar" })).toThrow(/reserved local/i);
    expect(() => harnessKey({ ref: "local-foo" })).not.toThrow();
  });
});
