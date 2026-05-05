import { describe, it, expect, mock } from "bun:test";
import plugin from "../index.ts";

interface Emit { event: string; payload: any }

function makeCtx(opts: { rateTable?: Record<string, any> } = {}) {
  const subscribed: string[] = [];
  const handlers: Record<string, (p: any) => void | Promise<void>> = {};
  const emits: Emit[] = [];
  return {
    subscribed,
    handlers,
    emits,
    log: mock(() => {}),
    config: {},
    defineEvent: mock(() => {}),
    on: mock((name: string, fn: (p: any) => void) => { subscribed.push(name); handlers[name] = fn; }),
    emit: mock(async (event: string, payload: any) => { emits.push({ event, payload }); return []; }),
    defineService: mock(() => {}),
    provideService: mock(() => {}),
    consumeService: mock(() => {}),
    useService: mock(() => undefined),
    secrets: { get: mock(async () => undefined), refresh: mock(async () => undefined) },
    // Internal facades the plugin reads — see Step 2 implementation.
    _testCostDeps: {
      home: "/home/u",
      readFile: async () => JSON.stringify({ rates: opts.rateTable ?? {} }),
    },
  } as any;
}

describe("llm-status-items setup", () => {
  it("subscribes to exactly the spec'd events", async () => {
    const ctx = makeCtx();
    await plugin.setup(ctx);
    expect(ctx.subscribed.sort()).toEqual([
      "conversation:cleared",
      "llm:before-call",
      "llm:done",
      "session:start",
      "tool:before-execute",
      "tool:error",
      "tool:result",
      "turn:end",
      "turn:start",
    ]);
  });

  it("emits status:item-update for model on llm:before-call", async () => {
    const ctx = makeCtx();
    await plugin.setup(ctx);
    await ctx.handlers["llm:before-call"]!({ request: { model: "gpt-4.1-mini", messages: [] } });
    const modelEmit = ctx.emits.find((e: Emit) => e.event === "status:item-update" && e.payload?.key === "model");
    expect(modelEmit?.payload.value).toBe("gpt-4.1-mini");
  });

  it("accumulates tokens across two llm:done events", async () => {
    const ctx = makeCtx();
    await plugin.setup(ctx);
    await ctx.handlers["llm:done"]!({ response: { content: "", finishReason: "stop", usage: { promptTokens: 100, completionTokens: 50 } } });
    await ctx.handlers["llm:done"]!({ response: { content: "", finishReason: "stop", usage: { promptTokens: 300, completionTokens: 150 } } });
    const lastIn = [...ctx.emits].reverse().find((e: Emit) => e.event === "status:item-update" && e.payload?.key === "in");
    const lastOut = [...ctx.emits].reverse().find((e: Emit) => e.event === "status:item-update" && e.payload?.key === "out");
    expect(lastIn?.payload.value).toBe("400");
    expect(lastOut?.payload.value).toBe("200");
  });

  it("conversation:cleared emits status:item-clear for token items (and cost-estimate if active)", async () => {
    const ctx = makeCtx({ rateTable: { "gpt-4.1-mini": { promptCentsPerMTok: 15, completionCentsPerMTok: 60 } } });
    await plugin.setup(ctx);
    await ctx.handlers["llm:before-call"]!({ request: { model: "gpt-4.1-mini", messages: [] } });
    await ctx.handlers["llm:done"]!({ response: { content: "", finishReason: "stop", usage: { promptTokens: 100, completionTokens: 50 } } });
    await ctx.handlers["conversation:cleared"]!({});
    const clears = ctx.emits.filter((e: Emit) => e.event === "status:item-clear").map((e: Emit) => e.payload.key);
    expect(clears).toContain("in");
    expect(clears).toContain("out");
    expect(clears).toContain("cost-estimate");
  });

  it("turn-state transitions: thinking → calling bash → thinking → ready", async () => {
    const ctx = makeCtx();
    await plugin.setup(ctx);
    await ctx.handlers["turn:start"]!({ turnId: "t-1" });
    await ctx.handlers["tool:before-execute"]!({ name: "bash", args: {}, callId: "c1" });
    await ctx.handlers["tool:result"]!({ callId: "c1", result: "ok" });
    await ctx.handlers["turn:end"]!({ turnId: "t-1", reason: "complete" });
    const turnStateValues = ctx.emits
      .filter((e: Emit) => e.event === "status:item-update" && e.payload?.key === "turn-state")
      .map((e: Emit) => e.payload.value);
    expect(turnStateValues).toEqual(["thinking", "calling bash", "thinking", "ready"]);
  });

  it("cost: with rate table, two llm:done emits the formatted dollar string", async () => {
    const ctx = makeCtx({
      rateTable: { "gpt-4.1-mini": { promptCentsPerMTok: 15, completionCentsPerMTok: 60 } },
    });
    await plugin.setup(ctx);
    await ctx.handlers["llm:before-call"]!({ request: { model: "gpt-4.1-mini", messages: [] } });
    await ctx.handlers["llm:done"]!({ response: { content: "", finishReason: "stop", usage: { promptTokens: 1_000_000, completionTokens: 1_000_000 } } });
    await ctx.handlers["llm:done"]!({ response: { content: "", finishReason: "stop", usage: { promptTokens: 1_000_000, completionTokens: 1_000_000 } } });
    const last = [...ctx.emits].reverse().find((e: Emit) => e.event === "status:item-update" && e.payload?.key === "cost-estimate");
    // 2 * (15 + 60) cents = 150 cents = $1.5000
    expect(last?.payload.value).toBe("$1.5000");
  });

  it("cost: model absent from rate table → no cost-estimate update; prior value cleared", async () => {
    const ctx = makeCtx({ rateTable: { "gpt-4.1": { promptCentsPerMTok: 200, completionCentsPerMTok: 800 } } });
    await plugin.setup(ctx);
    // Switch to a known model first to seed a prior value.
    await ctx.handlers["llm:before-call"]!({ request: { model: "gpt-4.1", messages: [] } });
    await ctx.handlers["llm:done"]!({ response: { content: "", finishReason: "stop", usage: { promptTokens: 100, completionTokens: 50 } } });
    // Now switch to an unknown model.
    await ctx.handlers["llm:before-call"]!({ request: { model: "unknown-model", messages: [] } });
    await ctx.handlers["llm:done"]!({ response: { content: "", finishReason: "stop", usage: { promptTokens: 100, completionTokens: 50 } } });
    const lastClearOrUpdate = [...ctx.emits].reverse().find(
      (e: Emit) => (e.event === "status:item-update" || e.event === "status:item-clear") && e.payload?.key === "cost-estimate",
    );
    expect(lastClearOrUpdate?.event).toBe("status:item-clear");
  });

  it("model value reflects post-mutation request (memory-injection scenario)", async () => {
    const ctx = makeCtx();
    await plugin.setup(ctx);
    // Pretend an upstream subscriber already mutated request.model.
    await ctx.handlers["llm:before-call"]!({ request: { model: "memory-injected-model", messages: [] } });
    const modelEmit = ctx.emits.find((e: Emit) => e.event === "status:item-update" && e.payload?.key === "model");
    expect(modelEmit?.payload.value).toBe("memory-injected-model");
  });
});
