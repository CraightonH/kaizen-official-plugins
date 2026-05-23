import { describe, it, expect } from "bun:test";
import { matchesQuery, filterByQuery } from "./query-match.ts";

describe("matchesQuery", () => {
  it("returns true for empty / whitespace query", () => {
    expect(matchesQuery("anything", "")).toBe(true);
    expect(matchesQuery("anything", "   ")).toBe(true);
  });

  it("matches case-insensitive substring (not just prefix)", () => {
    expect(matchesQuery("apiKey", "key")).toBe(true);
    expect(matchesQuery("apiKey", "KEY")).toBe(true);
    expect(matchesQuery("apiKey", "iK")).toBe(true);
  });

  it("returns false when no substring match", () => {
    expect(matchesQuery("apiKey", "zzz")).toBe(false);
  });
});

describe("filterByQuery", () => {
  const items = [
    { label: "apiKey", detail: "string · secret" },
    { label: "backend", detail: "enum" },
    { label: "enabled", detail: "boolean" },
  ];

  it("empty query returns all items unchanged", () => {
    expect(filterByQuery(items, "")).toEqual(items);
  });

  it("filters by case-insensitive substring of label", () => {
    expect(filterByQuery(items, "key").map((i) => i.label)).toEqual(["apiKey"]);
    expect(filterByQuery(items, "KEY").map((i) => i.label)).toEqual(["apiKey"]);
    expect(filterByQuery(items, "en").map((i) => i.label)).toEqual(["backend", "enabled"]);
  });

  it("matches label only, not detail", () => {
    expect(filterByQuery(items, "secret")).toEqual([]);
  });
});
