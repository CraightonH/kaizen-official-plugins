import { describe, it, expect } from "bun:test";
import { snapshotMessages, aggregateUsage } from "../state.ts";
import type { ChatMessage } from "llm-events/public";

describe("snapshotMessages", () => {
  it("returns a new array with the same elements", () => {
    const a: ChatMessage[] = [{ role: "user", content: "hi" }];
    const b = snapshotMessages(a);
    expect(b).not.toBe(a);
    expect(b).toEqual(a);
  });

  it("element identity preserved (shallow copy)", () => {
    const m: ChatMessage = { role: "user", content: "hi" };
    const b = snapshotMessages([m]);
    expect(b[0]).toBe(m);
  });
});

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
