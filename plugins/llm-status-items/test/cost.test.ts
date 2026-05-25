import { describe, it, expect } from "bun:test";
import { tokensToCents, formatDollars } from "../cost.ts";

describe("tokensToCents", () => {
  const rates = {
    "gpt-4.1-mini": { promptCentsPerMTok: 15, completionCentsPerMTok: 60 },
  };

  it("returns null when model is missing", () => {
    expect(tokensToCents(rates, "unknown-model", { promptTokens: 100, completionTokens: 50 })).toBeNull();
  });

  it("computes cents for known model", () => {
    // 1_000_000 prompt @ 15 cents = 15 cents; 1_000_000 completion @ 60 cents = 60 cents
    expect(tokensToCents(rates, "gpt-4.1-mini", { promptTokens: 1_000_000, completionTokens: 1_000_000 })).toBeCloseTo(75, 6);
  });

  it("scales linearly", () => {
    expect(tokensToCents(rates, "gpt-4.1-mini", { promptTokens: 100, completionTokens: 50 })).toBeCloseTo(
      (100 * 15 + 50 * 60) / 1_000_000, 9,
    );
  });
});

describe("formatDollars", () => {
  it("formats cents with the requested decimal places", () => {
    expect(formatDollars(0, 4)).toBe("$0.0000");
    expect(formatDollars(1.23, 4)).toBe("$0.0123");
    expect(formatDollars(12345, 4)).toBe("$123.4500");
  });

  it("honors a different decimal precision", () => {
    expect(formatDollars(12345, 2)).toBe("$123.45");
    expect(formatDollars(0, 0)).toBe("$0");
  });
});
