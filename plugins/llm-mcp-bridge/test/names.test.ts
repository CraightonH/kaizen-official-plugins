import { describe, it, expect } from "bun:test";
import { isValidServerName, kaizenToolName, kaizenToolTags, MCP_NAME_RE } from "../names.ts";

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
