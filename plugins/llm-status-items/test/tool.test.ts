import { describe, it, expect } from "bun:test";
import { registerStatusTool, type ToolsRegistryLike, type ToolHandlerLike } from "../tool.ts";
import type { StatusSnapshot } from "../snapshot.ts";
import type { ToolSchema } from "llm-contracts/public";

interface Registered {
  schema: ToolSchema;
  handler: ToolHandlerLike;
}

function makeFakeRegistry(): { reg: ToolsRegistryLike; entries: Registered[] } {
  const entries: Registered[] = [];
  const reg: ToolsRegistryLike = {
    register(schema, handler) {
      entries.push({ schema, handler });
      return () => {};
    },
  };
  return { reg, entries };
}

function snap(): StatusSnapshot {
  return {
    model: "gpt-4o-mini",
    session: { id: "abc", alias: null },
    contextWindow: { lastPromptTokens: 100, contextLength: 1000, pctUsed: 0.1 },
    sessionTotals: { promptTokens: 100, completionTokens: 50 },
    tokensPerSec: 12.3,
    costCents: null,
  };
}

describe("status:show tool adapter", () => {
  it("registers a tool named 'status:show' with zero-arg schema", () => {
    const { reg, entries } = makeFakeRegistry();
    registerStatusTool(reg, snap);
    expect(entries.length).toBe(1);
    expect(entries[0]!.schema.name).toBe("status:show");
    expect(entries[0]!.schema.parameters).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
  });

  it("returns the snapshot verbatim from the getter", async () => {
    const { reg, entries } = makeFakeRegistry();
    const fixed = snap();
    registerStatusTool(reg, () => fixed);
    const fakeCtx = {
      signal: new AbortController().signal,
      callId: "call-1",
      log: () => {},
    };
    const result = await entries[0]!.handler({}, fakeCtx);
    expect(result).toBe(fixed);
  });

  it("re-evaluates the getter on every invocation", async () => {
    const { reg, entries } = makeFakeRegistry();
    let n = 0;
    registerStatusTool(reg, () => ({ ...snap(), tokensPerSec: ++n }));
    const fakeCtx = {
      signal: new AbortController().signal,
      callId: "c",
      log: () => {},
    };
    const r1 = (await entries[0]!.handler({}, fakeCtx)) as StatusSnapshot;
    const r2 = (await entries[0]!.handler({}, fakeCtx)) as StatusSnapshot;
    expect(r1.tokensPerSec).toBe(1);
    expect(r2.tokensPerSec).toBe(2);
  });
});
