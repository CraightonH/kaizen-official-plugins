import { describe, it, expect } from "bun:test";
import { computeArgSlot } from "./arg-completion.ts";

describe("computeArgSlot", () => {
  it("returns null when line is not a slash command", () => {
    expect(computeArgSlot("hello world", 5)).toBeNull();
  });

  it("identifies slot 0 with empty query right after the command", () => {
    const r = computeArgSlot("/config:set ", 12);
    expect(r).toEqual({ name: "config:set", slotIndex: 0, prevArgs: [], query: "", anchor: 12, flagMode: false });
  });

  it("identifies slot 0 with partial token", () => {
    const r = computeArgSlot("/config:set kaiz", 16);
    expect(r).toEqual({ name: "config:set", slotIndex: 0, prevArgs: [], query: "kaiz", anchor: 12, flagMode: false });
  });

  it("identifies slot 1 with prev args populated", () => {
    const r = computeArgSlot("/config:set kaizen-config m", 27);
    expect(r).toEqual({ name: "config:set", slotIndex: 1, prevArgs: ["kaizen-config"], query: "m", anchor: 26, flagMode: false });
  });

  it("treats flags as non-positional", () => {
    const r = computeArgSlot("/config:set --project kaizen-config ", 36);
    // --project stripped from positional; slot 1 ready with prev=["kaizen-config"]
    expect(r?.slotIndex).toBe(1);
    expect(r?.prevArgs).toEqual(["kaizen-config"]);
    expect(r?.query).toBe("");
  });

  it("returns flagMode after all positional slots filled", () => {
    const r = computeArgSlot("/config:set kaizen-config model=gpt ", 36);
    expect(r?.flagMode).toBe(true);
    expect(r?.slotIndex).toBe(2);
    expect(r?.query).toBe("");
  });

  it("computes flagMode with partial flag token", () => {
    const r = computeArgSlot("/config:set kaizen-config model=gpt --pr", 40);
    expect(r?.flagMode).toBe(true);
    expect(r?.query).toBe("--pr");
  });
});
