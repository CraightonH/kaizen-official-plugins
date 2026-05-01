import { describe, it, expect } from "bun:test";
import { pickBusyMessage, BUSY_MESSAGES } from "../busy-messages.ts";

describe("busy-messages", () => {
  it("BUSY_MESSAGES is non-empty array of strings", () => {
    expect(Array.isArray(BUSY_MESSAGES)).toBe(true);
    expect(BUSY_MESSAGES.length).toBeGreaterThan(0);
    for (const m of BUSY_MESSAGES) expect(typeof m).toBe("string");
  });

  it("pickBusyMessage returns one of BUSY_MESSAGES", () => {
    for (let i = 0; i < 50; i++) {
      expect(BUSY_MESSAGES).toContain(pickBusyMessage());
    }
  });
});
