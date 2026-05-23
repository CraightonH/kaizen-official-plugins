import { describe, it, expect } from "bun:test";
import { matchesQuery, filterByQuery } from "./query-match.ts";

describe("matchesQuery", () => {
  it("returns true for empty / whitespace query", () => {
    expect(matchesQuery("anything", "")).toBe(true);
    expect(matchesQuery("anything", "   ")).toBe(true);
  });

  it("matches case-insensitive substring (not just prefix)", () => {
    expect(matchesQuery("config:set", "set")).toBe(true);
    expect(matchesQuery("config:set", "CONFIG")).toBe(true);
    expect(matchesQuery("apiKey", "Key")).toBe(true);
  });

  it("returns false when no substring match", () => {
    expect(matchesQuery("config:set", "zzz")).toBe(false);
  });
});

describe("filterByQuery", () => {
  const items = [
    { label: "/help", detail: "help" },
    { label: "/config:get", detail: "get" },
    { label: "/config:set", detail: "set" },
  ];

  it("empty query returns all items unchanged", () => {
    expect(filterByQuery(items, "")).toEqual(items);
    expect(filterByQuery(items, "   ")).toEqual(items);
  });

  it("filters by case-insensitive substring of label", () => {
    expect(filterByQuery(items, "CONFIG").map((i) => i.label))
      .toEqual(["/config:get", "/config:set"]);
    expect(filterByQuery(items, "set").map((i) => i.label))
      .toEqual(["/config:set"]);
  });

  it("matches label only, not detail", () => {
    const itemsWithDetailMatch = [{ label: "/x", detail: "set" }];
    expect(filterByQuery(itemsWithDetailMatch, "set")).toEqual([]);
  });
});
