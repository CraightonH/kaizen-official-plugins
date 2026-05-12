import { describe, it, expect, mock } from "bun:test";
import plugin from "../index.ts";

interface Emit { event: string; payload: any }

const VOCAB = {
  HARNESS_START: "harness:start",
  LLM_BEFORE_CALL: "llm:before-call",
  LLM_DONE: "llm:done",
  TURN_START: "turn:start",
  TURN_END: "turn:end",
  TOOL_BEFORE_EXECUTE: "tool:before-execute",
  TOOL_RESULT: "tool:result",
  TOOL_ERROR: "tool:error",
  CONVERSATION_CLEARED: "conversation:cleared",
  SESSION_ACTIVE_CHANGED: "session:active-changed",
  SESSION_RENAMED: "session:renamed",
  STATUS_ITEM_UPDATE: "status:item-update",
  STATUS_ITEM_CLEAR: "status:item-clear",
};

function makeCtx(opts: { rateTable?: Record<string, any> } = {}) {
  const subscribed: string[] = [];
  // Support multiple handlers per event name (plugins may register more than
  // one ctx.on() for the same event — e.g. harness:start for both the reducer
  // and adapter registration).
  const handlerLists: Record<string, Array<(p: any) => void | Promise<void>>> = {};
  const handlers = new Proxy({} as Record<string, (p: any) => Promise<void>>, {
    get(_t, name: string) {
      const fns = handlerLists[name];
      if (!fns || fns.length === 0) return undefined;
      return async (p: any) => { for (const fn of fns) await fn(p); };
    },
    set(_t, name: string, fn: (p: any) => void | Promise<void>) {
      handlerLists[name] = [fn];
      return true;
    },
  });
  const emits: Emit[] = [];
  return {
    subscribed,
    handlers,
    emits,
    log: mock(() => {}),
    config: {},
    defineEvent: mock(() => {}),
    on: mock((name: string, fn: (p: any) => void) => {
      subscribed.push(name);
      if (!handlerLists[name]) handlerLists[name] = [];
      handlerLists[name].push(fn);
    }),
    emit: mock(async (event: string, payload: any) => { emits.push({ event, payload }); return []; }),
    defineService: mock(() => {}),
    provideService: mock(() => {}),
    consumeService: mock(() => {}),
    useService: mock((id: string) => id === "llm-events:vocabulary" ? VOCAB : undefined),
    secrets: { get: mock(async () => undefined), refresh: mock(async () => undefined) },
    // Internal facades the plugin reads — see Step 2 implementation.
    _testCostDeps: {
      home: "/home/u",
      readFile: async () => JSON.stringify({ rates: opts.rateTable ?? {} }),
    },
  } as any;
}

describe("llm-status-items setup", () => {
  it("requires only the events vocabulary and LLM completion service", () => {
    expect(plugin.services?.consumes).toEqual(["llm-events:vocabulary", "llm:complete"]);
  });

  it("subscribes to exactly the spec'd events", async () => {
    const ctx = makeCtx();
    await plugin.setup(ctx);
    // Dedupe before sort: the registration wiring adds a second harness:start
    // handler (for adapter registration) but the event set is the same.
    expect([...new Set(ctx.subscribed)].sort()).toEqual([
      "conversation:cleared",
      "harness:start",
      "llm:before-call",
      "llm:done",
      "session:active-changed",
      "session:renamed",
      "tool:before-execute",
      "tool:error",
      "tool:result",
      "turn:end",
      "turn:start",
    ]);
  });

  it("session:renamed re-emits session item with `id (alias)` formatting", async () => {
    const ctx = makeCtx();
    await plugin.setup(ctx);
    await ctx.handlers["session:active-changed"]!({ from: null, to: "abc12345-6789-0000-0000-000000000000", alias: null });
    await ctx.handlers["session:renamed"]!({ id: "abc12345-6789-0000-0000-000000000000", alias: "test" });
    const lastSession = [...ctx.emits].reverse().find((e: Emit) => e.payload?.key === "session");
    expect(lastSession?.event).toBe("status:item-update");
    expect(lastSession?.payload.value).toBe("abc12345-6789-0000-0000-000000000000 (test)");
  });

  it("session:renamed for a non-active session is ignored", async () => {
    const ctx = makeCtx();
    await plugin.setup(ctx);
    await ctx.handlers["session:active-changed"]!({ from: null, to: "abc12345-6789-0000-0000-000000000000", alias: null });
    const before = ctx.emits.filter((e: Emit) => e.payload?.key === "session").length;
    await ctx.handlers["session:renamed"]!({ id: "ffffffff-0000-0000-0000-000000000000", alias: "other" });
    const after = ctx.emits.filter((e: Emit) => e.payload?.key === "session").length;
    expect(after).toBe(before);
  });

  it("emits full session id on session:active-changed; clears on logout", async () => {
    const ctx = makeCtx();
    await plugin.setup(ctx);
    await ctx.handlers["session:active-changed"]!({ from: null, to: "abc12345-6789-0000-0000-000000000000" });
    const upd = ctx.emits.find((e: Emit) => e.event === "status:item-update" && e.payload?.key === "session");
    expect(upd?.payload.value).toBe("abc12345-6789-0000-0000-000000000000");
    await ctx.handlers["session:active-changed"]!({ from: "abc12345-6789-0000-0000-000000000000", to: null });
    const clr = ctx.emits.find((e: Emit) => e.event === "status:item-clear" && e.payload?.key === "session");
    expect(clr).toBeDefined();
  });

  it("does not re-emit session when the id is unchanged", async () => {
    const ctx = makeCtx();
    await plugin.setup(ctx);
    await ctx.handlers["session:active-changed"]!({ from: null, to: "abc12345-6789-0000-0000-000000000000" });
    await ctx.handlers["session:active-changed"]!({ from: null, to: "abc12345-6789-0000-0000-000000000000" });
    const sessionEmits = ctx.emits.filter((e: Emit) => e.payload?.key === "session");
    expect(sessionEmits.length).toBe(1);
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

describe("status:show slash + tool registration", () => {
  it("registers /status:show on slash:registry and 'status:show' on tools:registry on harness:start", async () => {
    const ctx = makeCtx();
    const slashRegistered: Array<{ name: string }> = [];
    const toolsRegistered: Array<{ name: string }> = [];
    ctx.useService = mock((id: string) => {
      if (id === "llm-events:vocabulary") return VOCAB;
      if (id === "slash:registry") {
        return {
          register: (manifest: any) => {
            slashRegistered.push({ name: manifest.name });
            return () => {};
          },
        };
      }
      if (id === "tools:registry") {
        return {
          register: (schema: any) => {
            toolsRegistered.push({ name: schema.name });
            return () => {};
          },
        };
      }
      return undefined;
    });
    await plugin.setup(ctx);
    await ctx.handlers["harness:start"]!({});
    expect(slashRegistered.map((e) => e.name)).toContain("status:show");
    expect(toolsRegistered.map((e) => e.name)).toContain("status:show");
  });

  it("slash and tool adapters reflect the same snapshot derived from StatusState", async () => {
    const ctx = makeCtx();
    let slashHandler: ((ctx: { args: string; print: (t: string) => Promise<void> }) => Promise<void>) | null = null;
    let toolHandler: ((args: any, ctx: any) => Promise<unknown>) | null = null;
    ctx.useService = mock((id: string) => {
      if (id === "llm-events:vocabulary") return VOCAB;
      if (id === "slash:registry") {
        return {
          register: (manifest: any, h: any) => {
            if (manifest.name === "status:show") slashHandler = h;
            return () => {};
          },
        };
      }
      if (id === "tools:registry") {
        return {
          register: (schema: any, h: any) => {
            if (schema.name === "status:show") toolHandler = h;
            return () => {};
          },
        };
      }
      return undefined;
    });
    await plugin.setup(ctx);
    await ctx.handlers["harness:start"]!({});
    // Drive some state through the reducer.
    await ctx.handlers["llm:before-call"]!({ request: { model: "gpt-4o-mini" } });
    await ctx.handlers["llm:done"]!({
      response: { usage: { promptTokens: 100, completionTokens: 50 } },
    });

    const printed: string[] = [];
    await slashHandler!({ args: "", print: async (t) => { printed.push(t); } });
    const toolResult = (await toolHandler!({}, { signal: new AbortController().signal, callId: "c", log: () => {} })) as any;

    expect(printed[0]).toContain("model:           gpt-4o-mini");
    expect(printed[0]).toContain("in=100");
    expect(printed[0]).toContain("out=50");
    expect(toolResult.model).toBe("gpt-4o-mini");
    expect(toolResult.sessionTotals).toEqual({ promptTokens: 100, completionTokens: 50 });
    expect(toolResult.contextWindow.lastPromptTokens).toBe(100);
  });

  it("works without slash:registry or tools:registry (both soft)", async () => {
    const ctx = makeCtx();
    ctx.useService = mock((id: string) => id === "llm-events:vocabulary" ? VOCAB : undefined);
    await plugin.setup(ctx);
    // Should not throw.
    await ctx.handlers["harness:start"]!({});
  });

  it("registers adapters only once across duplicate harness:start events", async () => {
    const ctx = makeCtx();
    let slashCount = 0;
    let toolCount = 0;
    ctx.useService = mock((id: string) => {
      if (id === "llm-events:vocabulary") return VOCAB;
      if (id === "slash:registry") return { register: () => { slashCount += 1; return () => {}; } };
      if (id === "tools:registry") return { register: () => { toolCount += 1; return () => {}; } };
      return undefined;
    });

    await plugin.setup(ctx);
    await ctx.handlers["harness:start"]!({});
    await ctx.handlers["harness:start"]!({});

    expect(slashCount).toBe(1);
    expect(toolCount).toBe(1);
  });

  it("stop unregisters slash and tool adapters", async () => {
    const ctx = makeCtx();
    const unregisterSlash = mock(() => {});
    const unregisterTool = mock(() => {});
    ctx.useService = mock((id: string) => {
      if (id === "llm-events:vocabulary") return VOCAB;
      if (id === "slash:registry") return { register: () => unregisterSlash };
      if (id === "tools:registry") return { register: () => unregisterTool };
      return undefined;
    });

    await plugin.setup(ctx);
    await ctx.handlers["harness:start"]!({});
    await plugin.stop!(ctx);

    expect(unregisterSlash).toHaveBeenCalledTimes(1);
    expect(unregisterTool).toHaveBeenCalledTimes(1);
  });
});
