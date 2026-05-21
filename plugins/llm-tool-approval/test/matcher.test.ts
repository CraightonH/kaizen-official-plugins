import { describe, it, expect } from "bun:test";
import { matches, deriveDomain, matchesAny } from "../matcher.ts";
import { parseRule, compilePattern } from "../matcher.ts";

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

describe("parseRule", () => {
  it("returns name-only for rules with no parentheses", () => {
    expect(parseRule("fs:read_file")).toEqual({ name: "fs:read_file" });
    expect(parseRule("mcp:github:*")).toEqual({ name: "mcp:github:*" });
    expect(parseRule("*")).toEqual({ name: "*" });
  });

  it("splits name and pattern when parentheses are present", () => {
    expect(parseRule("bash(ls *)")).toEqual({ name: "bash", pattern: "ls *" });
    expect(parseRule("web_search(*github.com/*)")).toEqual({
      name: "web_search",
      pattern: "*github.com/*",
    });
  });

  it("allows prefix-glob names with patterns", () => {
    expect(parseRule("mcp:github:*(foo)")).toEqual({
      name: "mcp:github:*",
      pattern: "foo",
    });
  });

  it("returns null for malformed rules", () => {
    expect(parseRule("bash(ls")).toBeNull();   // unclosed
    expect(parseRule("bash)")).toBeNull();     // close without open
    expect(parseRule("(pat)")).toBeNull();     // empty name
    expect(parseRule("bash()")).toBeNull();    // empty pattern
    expect(parseRule("bash(a)b")).toBeNull();  // trailing junk after )
  });

  it("ignores empty / non-string input", () => {
    expect(parseRule("")).toBeNull();
    expect(parseRule(undefined as unknown as string)).toBeNull();
  });
});

describe("compilePattern", () => {
  it("compiles literal patterns to anchored regex", () => {
    const re = compilePattern("ls");
    expect(re.test("ls")).toBe(true);
    expect(re.test("ls -la")).toBe(false);
  });

  it("translates * to any-character sequence (including /)", () => {
    const re = compilePattern("ls *");
    expect(re.test("ls -la")).toBe(true);
    expect(re.test("ls /tmp/a/b")).toBe(true);
    expect(re.test("rm -rf /")).toBe(false);
  });

  it("translates ? to one character", () => {
    const re = compilePattern("a?c");
    expect(re.test("abc")).toBe(true);
    expect(re.test("ac")).toBe(false);
    expect(re.test("abbc")).toBe(false);
  });

  it("supports character classes", () => {
    const re = compilePattern("[abc]oo");
    expect(re.test("aoo")).toBe(true);
    expect(re.test("doo")).toBe(false);
  });

  it("escapes regex metacharacters in the source pattern", () => {
    const re = compilePattern("a.b+c");
    expect(re.test("a.b+c")).toBe(true);
    expect(re.test("axbxxc")).toBe(false);
  });

  it("anchors the match", () => {
    const re = compilePattern("foo");
    expect(re.test("xfoox")).toBe(false);
  });
});
