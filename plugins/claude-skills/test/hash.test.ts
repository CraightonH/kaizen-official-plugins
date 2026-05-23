import { describe, it, expect } from "bun:test";
import { contentHash } from "../hash.ts";

describe("contentHash", () => {
  it("returns the same hash for identical input", () => {
    expect(contentHash("hello world")).toBe(contentHash("hello world"));
  });

  it("returns different hashes for different input", () => {
    expect(contentHash("hello world")).not.toBe(contentHash("hello worl"));
  });

  it("returns a hex string", () => {
    expect(contentHash("anything")).toMatch(/^[0-9a-f]+$/);
  });

  it("handles empty input", () => {
    expect(contentHash("")).toMatch(/^[0-9a-f]+$/);
  });
});
