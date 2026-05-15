import { describe, it, expect } from "bun:test";
import { matches, deriveDomain, matchesAny } from "../matcher.ts";

describe("matches", () => {
  it("exact name", () => {
    expect(matches("fs:read_file", "fs:read_file")).toBe(true);
    expect(matches("fs:read_file", "fs:read_files")).toBe(false);
    expect(matches("fs:read_file", "fs:write_file")).toBe(false);
  });

  it("prefix glob with trailing :*", () => {
    expect(matches("mcp:github:list_issues", "mcp:github:*")).toBe(true);
    expect(matches("mcp:github:create_issue", "mcp:github:*")).toBe(true);
    expect(matches("mcp:githubactions:run", "mcp:github:*")).toBe(false);
    expect(matches("mcp:github:", "mcp:github:*")).toBe(true);
  });

  it("multi-level prefix glob", () => {
    expect(matches("a:b:c:d", "a:b:c:*")).toBe(true);
    expect(matches("a:b:cd", "a:b:c:*")).toBe(false);
  });

  it("catch-all *", () => {
    expect(matches("anything", "*")).toBe(true);
    expect(matches("mcp:github:list", "*")).toBe(true);
  });

  it("malformed rule (no :*) does not glob", () => {
    expect(matches("fs:read_file", "fs*")).toBe(false);
  });

  it("empty / non-string tool names match nothing", () => {
    expect(matches("", "fs:*")).toBe(false);
    expect(matches("", "*")).toBe(true);
  });
});

describe("deriveDomain", () => {
  it("returns prefix:* for names with a colon", () => {
    expect(deriveDomain("mcp:github:list_issues")).toBe("mcp:github:*");
    expect(deriveDomain("fs:read_file")).toBe("fs:*");
    expect(deriveDomain("a:b:c:d")).toBe("a:b:c:*");
  });

  it("returns null for names without a colon", () => {
    expect(deriveDomain("execute_typescript")).toBeNull();
    expect(deriveDomain("")).toBeNull();
  });

  it("handles trailing colon", () => {
    expect(deriveDomain("fs:")).toBe("fs:*");
  });
});

describe("matchesAny", () => {
  it("returns true when any rule matches", () => {
    expect(matchesAny("fs:read_file", ["foo", "fs:*", "bar"])).toBe(true);
  });
  it("returns false when no rule matches", () => {
    expect(matchesAny("fs:read_file", ["foo", "bar"])).toBe(false);
  });
  it("returns false on empty rule list", () => {
    expect(matchesAny("fs:read_file", [])).toBe(false);
  });
});
