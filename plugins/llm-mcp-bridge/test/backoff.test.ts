import { describe, it, expect } from "bun:test";
import { computeBackoffMs, MAX_BACKOFF_MS, RETRY_BUDGET } from "../backoff.ts";

describe("backoff", () => {
  it("attempt 1 -> 1000ms", () => expect(computeBackoffMs(1)).toBe(1000));
  it("attempt 2 -> 2000ms", () => expect(computeBackoffMs(2)).toBe(2000));
  it("attempt 3 -> 4000ms", () => expect(computeBackoffMs(3)).toBe(4000));
  it("attempt 4 -> 8000ms", () => expect(computeBackoffMs(4)).toBe(8000));
  it("attempt 5 -> 16000ms", () => expect(computeBackoffMs(5)).toBe(16000));
  it("attempt 6 -> capped at 60000ms", () => expect(computeBackoffMs(6)).toBe(60000));
  it("attempt 999 -> still capped", () => expect(computeBackoffMs(999)).toBe(MAX_BACKOFF_MS));
  it("RETRY_BUDGET is 5", () => expect(RETRY_BUDGET).toBe(5));
});
