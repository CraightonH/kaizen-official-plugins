import { describe, it, expect } from "bun:test";
import { isValidServerName, kaizenToolName, kaizenToolTags, MCP_NAME_RE, normalizeServerName, detectConflicts } from "../names.ts";

describe("names", () => {
  it("MCP_NAME_RE matches lowercase alnum + _ + - starting alnum", () => {
    expect(MCP_NAME_RE.test("filesystem")).toBe(true);
    expect(MCP_NAME_RE.test("github_v2")).toBe(true);
    expect(MCP_NAME_RE.test("a-b-c")).toBe(true);
    expect(MCP_NAME_RE.test("0abc")).toBe(true);
    expect(MCP_NAME_RE.test("-abc")).toBe(false);
    expect(MCP_NAME_RE.test("Abc")).toBe(false);
    expect(MCP_NAME_RE.test("a b")).toBe(false);
    expect(MCP_NAME_RE.test("")).toBe(false);
  });

  it("isValidServerName mirrors the regex", () => {
    expect(isValidServerName("ok")).toBe(true);
    expect(isValidServerName("not ok")).toBe(false);
  });

  it("kaizenToolName produces mcp:<server>:<tool>", () => {
    expect(kaizenToolName("github", "search_code")).toBe("mcp:github:search_code");
  });

  it("kaizenToolTags produces [mcp, mcp:<server>]", () => {
    expect(kaizenToolTags("github")).toEqual(["mcp", "mcp:github"]);
  });
});

describe("normalizeServerName", () => {
  it("replaces non-alnum/underscore chars with underscore", () => {
    expect(normalizeServerName("foo-bar")).toBe("foo_bar");
    expect(normalizeServerName("foo bar")).toBe("foo_bar");
    expect(normalizeServerName("foo.bar")).toBe("foo_bar");
  });

  it("prepends underscore when name starts with a digit", () => {
    expect(normalizeServerName("1server")).toBe("_1server");
  });

  it("leaves already-valid identifiers unchanged", () => {
    expect(normalizeServerName("foo_bar")).toBe("foo_bar");
    expect(normalizeServerName("FooBar")).toBe("FooBar");
  });
});

describe("detectConflicts", () => {
  it("returns conflict when two names normalize to the same identifier", () => {
    const conflicts = detectConflicts(["foo-bar", "foo_bar"]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].normalized).toBe("foo_bar");
    expect(conflicts[0].servers.sort()).toEqual(["foo-bar", "foo_bar"].sort());
  });

  it("returns no conflicts for all-distinct normalized names", () => {
    const conflicts = detectConflicts(["alpha", "beta", "gamma"]);
    expect(conflicts).toHaveLength(0);
  });

  it("handles empty list", () => {
    expect(detectConflicts([])).toHaveLength(0);
  });
});
