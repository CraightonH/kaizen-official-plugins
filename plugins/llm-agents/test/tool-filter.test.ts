import { describe, it, expect } from "bun:test";
import { matchesGlob, toolMatches } from "../tool-filter.ts";

describe("matchesGlob", () => {
  it("exact match", () => {
    expect(matchesGlob("read_file", "read_file")).toBe(true);
    expect(matchesGlob("read_file", "write_file")).toBe(false);
  });
  it("trailing wildcard", () => {
    expect(matchesGlob("read_file", "read_*")).toBe(true);
    expect(matchesGlob("read_file", "write_*")).toBe(false);
  });
  it("internal and leading wildcard", () => {
    expect(matchesGlob("get_weather", "get_*")).toBe(true);
    expect(matchesGlob("get_weather", "*_weather")).toBe(true);
    expect(matchesGlob("xyz", "*")).toBe(true);
  });
  it("escapes regex metacharacters in the literal portions", () => {
    expect(matchesGlob("a.b", "a.b")).toBe(true);
    expect(matchesGlob("axb", "a.b")).toBe(false);
  });
});

describe("toolMatches", () => {
  it("admits when names glob hits", () => {
    expect(toolMatches({ name: "read_file", tags: [] }, { names: ["read_*"] })).toBe(true);
  });
  it("admits when tags overlap", () => {
    expect(toolMatches({ name: "x", tags: ["read-only"] }, { tags: ["read-only"] })).toBe(true);
  });
  it("OR over names + tags", () => {
    expect(toolMatches({ name: "x", tags: ["mutate"] }, { names: ["read_*"], tags: ["mutate"] })).toBe(true);
    expect(toolMatches({ name: "x", tags: ["other"] }, { names: ["read_*"], tags: ["mutate"] })).toBe(false);
  });
  it("empty filter admits nothing", () => {
    expect(toolMatches({ name: "x", tags: ["a"] }, {})).toBe(false);
    expect(toolMatches({ name: "x", tags: ["a"] }, undefined)).toBe(false);
  });
});
