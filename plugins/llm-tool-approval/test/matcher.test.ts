import { describe, it, expect } from "bun:test";
import { matches, deriveDomain, matchesAny, matchRule, matchesAnyRule } from "../matcher.ts";
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

describe("matchRule (name-only rules)", () => {
  it("falls back to name match when rule has no pattern", () => {
    expect(matchRule("fs:read_file", {}, "fs:read_file")).toBe(true);
    expect(matchRule("fs:read_file", {}, "fs:*")).toBe(true);
    expect(matchRule("fs:write_file", {}, "fs:read_file")).toBe(false);
  });

  it("ignores args when rule has no pattern", () => {
    expect(matchRule("bash", { command: "rm -rf /" }, "bash")).toBe(true);
  });
});

describe("matchRule (arg patterns)", () => {
  it("matches when a string leaf glob-matches the pattern", () => {
    expect(matchRule("bash", { command: "ls -la" }, "bash(ls *)")).toBe(true);
    expect(matchRule("bash", { command: "git status" }, "bash(git *)")).toBe(true);
  });

  it("does not match when no string leaf matches", () => {
    expect(matchRule("bash", { command: "rm -rf /" }, "bash(ls *)")).toBe(false);
  });

  it("does not match when name differs", () => {
    expect(matchRule("read", { command: "ls" }, "bash(ls *)")).toBe(false);
  });

  it("returns false when args have no string leaves", () => {
    expect(matchRule("bash", { count: 5 }, "bash(ls *)")).toBe(false);
  });

  it("matches nested string leaves", () => {
    expect(
      matchRule("web_search", { params: { url: "https://github.com/x" } }, "web_search(*github.com/*)"),
    ).toBe(true);
  });

  it("skips malformed rules silently (returns false)", () => {
    expect(matchRule("bash", { command: "ls" }, "bash(ls")).toBe(false);
  });
});

describe("matchesAnyRule", () => {
  it("returns true on first matching rule", () => {
    expect(
      matchesAnyRule("bash", { command: "ls -la" }, ["bash(rm *)", "bash(ls *)"]),
    ).toBe(true);
  });

  it("returns false when no rule matches", () => {
    expect(matchesAnyRule("bash", { command: "ls -la" }, ["bash(rm *)"])).toBe(false);
  });

  it("returns false on empty rule list", () => {
    expect(matchesAnyRule("bash", { command: "ls" }, [])).toBe(false);
  });

  it("mixes name-only and pattern rules in one list", () => {
    expect(
      matchesAnyRule("bash", { command: "rm -rf /" }, ["read", "bash(ls *)", "bash"]),
    ).toBe(true);
  });
});
