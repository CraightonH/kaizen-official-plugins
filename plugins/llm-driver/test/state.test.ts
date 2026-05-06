import { describe, it, expect } from "bun:test";
import { aggregateUsage } from "../state.ts";

describe("aggregateUsage", () => {
  it("returns zeros for empty input", () => {
    expect(aggregateUsage([])).toEqual({ promptTokens: 0, completionTokens: 0 });
  });

  it("sums prompt + completion tokens, ignoring undefined", () => {
    const u = aggregateUsage([
      { promptTokens: 10, completionTokens: 5 },
      undefined,
      { promptTokens: 7, completionTokens: 3 },
    ]);
    expect(u).toEqual({ promptTokens: 17, completionTokens: 8 });
  });
});
