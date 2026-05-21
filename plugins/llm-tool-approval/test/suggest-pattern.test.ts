import { describe, it, expect } from "bun:test";
import { suggestPattern } from "../suggest-pattern.ts";

describe("suggestPattern", () => {
  it("returns null when args have no string leaves", () => {
    expect(suggestPattern("bash", { count: 5 })).toBeNull();
  });

  it("for bash, uses first whitespace token + *", () => {
    expect(suggestPattern("bash", { command: "git status" })).toBe("git *");
    expect(suggestPattern("bash", { command: "ls -la /tmp" })).toBe("ls *");
    expect(suggestPattern("bash", { command: "echo" })).toBe("echo *");
  });

  it("for URL-shaped strings, suggests *<host>/*", () => {
    expect(suggestPattern("web_search", { url: "https://github.com/x/y" })).toBe(
      "*github.com/*",
    );
    expect(suggestPattern("web_fetch", { url: "http://api.example.com/v1/items" })).toBe(
      "*api.example.com/*",
    );
  });

  it("for path-shaped strings, suggests first-two-segments + /*", () => {
    expect(suggestPattern("read", { path: "/Users/chancock/foo/bar" })).toBe(
      "/Users/chancock/*",
    );
    expect(suggestPattern("glob", { pattern: "/etc/nginx/conf.d/*.conf" })).toBe(
      "/etc/nginx/*",
    );
  });

  it("for a short path with only one segment, suggests path + /*", () => {
    expect(suggestPattern("read", { path: "/tmp" })).toBe("/tmp/*");
  });

  it("for unrecognized strings, suggests the verbatim leaf", () => {
    expect(suggestPattern("axiom_record", { event: "click" })).toBe("click");
  });

  it("picks the longest leaf when multiple are present", () => {
    expect(
      suggestPattern("custom", { a: "short", b: "https://github.com/a/b/c" }),
    ).toBe("*github.com/*");
  });
});
