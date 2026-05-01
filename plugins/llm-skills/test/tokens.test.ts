import { describe, it, expect } from "bun:test";
import { estimateTokens } from "../tokens.ts";

describe("estimateTokens", () => {
  it("returns 0 for empty", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("ceils length/4", () => {
    expect(estimateTokens("a")).toBe(1);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });
});
