import { describe, it, expect } from "bun:test";
import { computeDepth, type TurnRecord } from "../depth.ts";

function rec(id: string, parent?: string, trigger: "user" | "agent" = "agent"): TurnRecord {
  return { turnId: id, parentTurnId: parent, trigger };
}

describe("computeDepth", () => {
  it("returns 0 for a missing turnId (defensive)", () => {
    const m = new Map();
    expect(computeDepth(m, "ghost")).toBe(0);
  });
  it("user turn = depth 0", () => {
    const m = new Map([[ "t1", rec("t1", undefined, "user") ]]);
    expect(computeDepth(m, "t1")).toBe(0);
  });
  it("first agent dispatch from user = depth 1", () => {
    const m = new Map([
      ["t1", rec("t1", undefined, "user")],
      ["t2", rec("t2", "t1", "agent")],
    ]);
    expect(computeDepth(m, "t2")).toBe(1);
  });
  it("depth N counts agent ancestors only", () => {
    const m = new Map([
      ["t1", rec("t1", undefined, "user")],
      ["t2", rec("t2", "t1", "agent")],
      ["t3", rec("t3", "t2", "agent")],
      ["t4", rec("t4", "t3", "agent")],
    ]);
    expect(computeDepth(m, "t4")).toBe(3);
  });
  it("stops at user even if chain is longer in the map", () => {
    const m = new Map([
      ["t1", rec("t1", undefined, "user")],
      ["t2", rec("t2", "t1", "agent")],
    ]);
    expect(computeDepth(m, "t2")).toBe(1);
  });
});
