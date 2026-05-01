import { describe, it, expect, mock } from "bun:test";
import { hasTrigger, maybeExtract } from "../extract.ts";

const TRIGGERS = ["from now on", "remember that", "always", "never", "i prefer", "my "];

describe("hasTrigger", () => {
  it("matches case-insensitively", () => {
    expect(hasTrigger("FROM NOW ON, do X", TRIGGERS)).toBe(true);
    expect(hasTrigger("Remember that the vault namespace is admin.", TRIGGERS)).toBe(true);
    expect(hasTrigger("hello world", TRIGGERS)).toBe(false);
  });
  it("does not match the bare word in a longer one", () => {
    expect(hasTrigger("Iodine is an element.", TRIGGERS)).toBe(false);
  });
});

describe("maybeExtract", () => {
  const baseDeps = () => ({
    config: { autoExtract: true, extractTriggers: TRIGGERS },
    runConversation: mock(async () => ({ finalMessage: { role: "assistant", content: "" }, messages: [], usage: { promptTokens: 0, completionTokens: 0 } })),
    log: () => {},
  });

  it("no-op when autoExtract is false", async () => {
    const d = baseDeps();
    d.config.autoExtract = false;
    await maybeExtract({ reason: "complete", lastUserMessage: "remember that X", turnId: "t1" }, d as any);
    expect(d.runConversation).not.toHaveBeenCalled();
  });
  it("no-op when reason !== complete", async () => {
    const d = baseDeps();
    await maybeExtract({ reason: "cancelled", lastUserMessage: "remember that X", turnId: "t1" }, d as any);
    expect(d.runConversation).not.toHaveBeenCalled();
  });
  it("no-op when no trigger matches", async () => {
    const d = baseDeps();
    await maybeExtract({ reason: "complete", lastUserMessage: "hello world", turnId: "t1" }, d as any);
    expect(d.runConversation).not.toHaveBeenCalled();
  });
  it("dispatches a side conversation with toolFilter when trigger matches", async () => {
    const d = baseDeps();
    await maybeExtract({ reason: "complete", lastUserMessage: "From now on always lower-case my variables.", turnId: "t1" }, d as any);
    expect(d.runConversation).toHaveBeenCalledTimes(1);
    const arg = (d.runConversation.mock.calls[0]![0]) as any;
    expect(arg.toolFilter).toEqual({ names: ["memory_save"] });
    expect(arg.parentTurnId).toBe("t1");
  });
  it("swallows errors from the side call (logs, does not throw)", async () => {
    const log = mock(() => {});
    const d = { ...baseDeps(), log };
    d.runConversation = mock(async () => { throw new Error("driver gone"); });
    await maybeExtract({ reason: "complete", lastUserMessage: "remember that x", turnId: "t1" }, d as any);
    expect(log).toHaveBeenCalled();
  });
});
