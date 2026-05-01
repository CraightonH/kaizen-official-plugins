import { describe, it, expect, mock } from "bun:test";
import { runConversation, type RunConversationDeps } from "../loop.ts";
import { makeIdGen } from "../ids.ts";
import type { LLMStreamEvent, LLMCompleteService, ChatMessage } from "llm-events/public";

function makeLlm(events: LLMStreamEvent[][]): LLMCompleteService & { calls: any[] } {
  let i = 0;
  const calls: any[] = [];
  const svc = {
    calls,
    async *complete(req: any, opts: any) {
      calls.push({ req, opts });
      const evs = events[i++] ?? [];
      for (const e of evs) yield e;
    },
    async listModels() { return []; },
  } as any;
  return svc;
}

interface RecEvent { name: string; payload: any; }
function makeEmit(): { emit: (n: string, p?: any) => Promise<void>; events: RecEvent[] } {
  const events: RecEvent[] = [];
  return {
    events,
    emit: async (name: string, payload: any) => { events.push({ name, payload }); },
  };
}

function makeDeps(overrides: Partial<RunConversationDeps> = {}): RunConversationDeps {
  const { emit } = makeEmit();
  return {
    emit,
    llmComplete: makeLlm([[{ type: "done", response: { content: "ok", finishReason: "stop" } }]]),
    registry: undefined,
    strategy: undefined,
    log: mock(() => {}),
    idGen: makeIdGen(["turn_test_1", "turn_test_2"]),
    defaultModel: "default-model",
    defaultSystemPrompt: "default-sp",
    ...overrides,
  };
}

describe("runConversation (A-tier)", () => {
  it("single-shot: emits turn:start, llm:before-call, llm:request, llm:done, turn:end", async () => {
    const { emit, events } = makeEmit();
    const llm = makeLlm([[{ type: "token", delta: "hi" }, { type: "done", response: { content: "hi", finishReason: "stop" } }]]);
    const deps = makeDeps({ emit, llmComplete: llm });
    const out = await runConversation({
      systemPrompt: "sys",
      messages: [{ role: "user", content: "yo" }],
      model: "m",
    }, deps);
    expect(events.map(e => e.name)).toEqual([
      "turn:start", "llm:before-call", "llm:request", "llm:token", "llm:done", "turn:end",
    ]);
    expect(out.messages).toEqual([
      { role: "user", content: "yo" },
      { role: "assistant", content: "hi" },
    ]);
    expect(out.finalMessage).toEqual({ role: "assistant", content: "hi" });
    expect(out.usage).toEqual({ promptTokens: 0, completionTokens: 0 });
  });

  it("turn:start carries trigger=agent and parentTurnId when supplied", async () => {
    const { emit, events } = makeEmit();
    const deps = makeDeps({ emit });
    await runConversation({
      systemPrompt: "sys", messages: [{ role: "user", content: "x" }], parentTurnId: "turn_parent",
    }, deps);
    const startEv = events.find(e => e.name === "turn:start")!;
    expect(startEv.payload.trigger).toBe("agent");
    expect(startEv.payload.parentTurnId).toBe("turn_parent");
    expect(typeof startEv.payload.turnId).toBe("string");
  });

  it("uses defaultModel when input.model is undefined", async () => {
    const llm = makeLlm([[{ type: "done", response: { content: "", finishReason: "stop" } }]]);
    const deps = makeDeps({ llmComplete: llm });
    await runConversation({ systemPrompt: "sys", messages: [] }, deps);
    expect((llm as any).calls[0].req.model).toBe("default-model");
  });

  it("does not mutate caller-supplied messages array", async () => {
    const messages: ChatMessage[] = Object.freeze([{ role: "user", content: "frozen" }]) as any;
    const llm = makeLlm([[{ type: "done", response: { content: "ok", finishReason: "stop" } }]]);
    const deps = makeDeps({ llmComplete: llm });
    const out = await runConversation({ systemPrompt: "sys", messages }, deps);
    expect(messages).toEqual([{ role: "user", content: "frozen" }]); // unchanged
    expect(out.messages).not.toBe(messages);
    expect(out.messages.length).toBe(2);
  });

  it("llm:request payload is deep-frozen", async () => {
    const { emit, events } = makeEmit();
    const deps = makeDeps({ emit });
    await runConversation({ systemPrompt: "sys", messages: [{ role: "user", content: "x" }] }, deps);
    const reqEv = events.find(e => e.name === "llm:request")!;
    expect(Object.isFrozen(reqEv.payload.request)).toBe(true);
    expect(Object.isFrozen(reqEv.payload.request.messages)).toBe(true);
  });

  it("LLM error event causes turn:error + turn:end{reason:error} and throws", async () => {
    const { emit, events } = makeEmit();
    const llm = makeLlm([[{ type: "error", message: "boom" }]]);
    const deps = makeDeps({ emit, llmComplete: llm });
    await expect(runConversation({ systemPrompt: "sys", messages: [{ role: "user", content: "x" }] }, deps))
      .rejects.toThrow(/boom/);
    const names = events.map(e => e.name);
    expect(names).toContain("turn:error");
    const endEv = events.find(e => e.name === "turn:end")!;
    expect(endEv.payload.reason).toBe("error");
  });

  it("stream ends without 'done' → error", async () => {
    const { emit, events } = makeEmit();
    const llm = makeLlm([[{ type: "token", delta: "a" }]]); // no done
    const deps = makeDeps({ emit, llmComplete: llm });
    await expect(runConversation({ systemPrompt: "sys", messages: [{ role: "user", content: "x" }] }, deps))
      .rejects.toThrow(/done/);
    const endEv = events.find(e => e.name === "turn:end")!;
    expect(endEv.payload.reason).toBe("error");
  });

  it("aggregates usage across multiple llm:done events (single call here)", async () => {
    const llm = makeLlm([[{ type: "done", response: { content: "ok", finishReason: "stop", usage: { promptTokens: 4, completionTokens: 2 } } }]]);
    const deps = makeDeps({ llmComplete: llm });
    const out = await runConversation({ systemPrompt: "sys", messages: [{ role: "user", content: "x" }] }, deps);
    expect(out.usage).toEqual({ promptTokens: 4, completionTokens: 2 });
  });
});

import type { ToolDispatchStrategy, ToolsRegistryService } from "../loop.ts";

function makeRegistry(tools: any[] = []): ToolsRegistryService {
  return {
    list: () => tools as any,
    invoke: async () => undefined,
  } as any;
}

function makeStrategy(handlers: Array<(input: any) => Promise<ChatMessage[]>>): ToolDispatchStrategy & { calls: any[] } {
  let i = 0;
  const calls: any[] = [];
  return {
    calls,
    prepareRequest: ({ availableTools }: any) => ({ tools: availableTools, systemPromptAppend: "[strategy]" }),
    handleResponse: async (input: any) => {
      calls.push(input);
      const h = handlers[i++];
      if (!h) return [];
      return h(input);
    },
  } as any;
}

describe("runConversation (multi-step strategy)", () => {
  it("strategy returns one tool message → second LLM call → empty appended → done", async () => {
    const { emit, events } = makeEmit();
    const llm = makeLlm([
      [{ type: "done", response: { content: "use tool", finishReason: "tool_calls", toolCalls: [{ id: "c1", name: "f", arguments: {} }] } }],
      [{ type: "done", response: { content: "final", finishReason: "stop" } }],
    ]);
    const strategy = makeStrategy([
      async () => [{ role: "tool", content: "tool-result", toolCallId: "c1", name: "f" }],
      async () => [], // terminal
    ]);
    const deps = makeDeps({ emit, llmComplete: llm, registry: makeRegistry(), strategy });
    const out = await runConversation({
      systemPrompt: "sys",
      messages: [{ role: "user", content: "go" }],
    }, deps);
    expect(out.messages.map(m => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect((llm as any).calls.length).toBe(2);
    // strategy.prepareRequest applied systemPromptAppend
    expect((llm as any).calls[0].req.systemPrompt).toContain("[strategy]");
    // strategy.tools forwarded
    expect((llm as any).calls[0].req.tools).toEqual([]);
  });

  it("strategy.handleResponse throws → turn:error + turn:end{reason:error}", async () => {
    const { emit, events } = makeEmit();
    const llm = makeLlm([
      [{ type: "done", response: { content: "x", finishReason: "tool_calls", toolCalls: [{ id: "c1", name: "f", arguments: {} }] } }],
    ]);
    const strategy = makeStrategy([
      async () => { throw new Error("strategy boom"); },
    ]);
    const deps = makeDeps({ emit, llmComplete: llm, registry: makeRegistry(), strategy });
    await expect(runConversation({
      systemPrompt: "sys", messages: [{ role: "user", content: "x" }],
    }, deps)).rejects.toThrow(/strategy boom/);
    const endEv = events.find(e => e.name === "turn:end")!;
    expect(endEv.payload.reason).toBe("error");
  });

  it("usage aggregated across multiple llm:done events", async () => {
    const llm = makeLlm([
      [{ type: "done", response: { content: "a", finishReason: "tool_calls", toolCalls: [{ id: "c1", name: "f", arguments: {} }], usage: { promptTokens: 10, completionTokens: 2 } } }],
      [{ type: "done", response: { content: "b", finishReason: "stop", usage: { promptTokens: 12, completionTokens: 4 } } }],
    ]);
    const strategy = makeStrategy([
      async () => [{ role: "tool", content: "r", toolCallId: "c1", name: "f" }],
      async () => [],
    ]);
    const deps = makeDeps({ llmComplete: llm, registry: makeRegistry(), strategy });
    const out = await runConversation({ systemPrompt: "sys", messages: [{ role: "user", content: "x" }] }, deps);
    expect(out.usage).toEqual({ promptTokens: 22, completionTokens: 6 });
  });

  it("only registry present (no strategy) takes A-tier path (degenerate)", async () => {
    const llm = makeLlm([[{ type: "done", response: { content: "ok", finishReason: "stop" } }]]);
    const deps = makeDeps({ llmComplete: llm, registry: makeRegistry(), strategy: undefined });
    const out = await runConversation({ systemPrompt: "sys", messages: [{ role: "user", content: "x" }] }, deps);
    expect((llm as any).calls.length).toBe(1);
    expect(out.messages.length).toBe(2);
  });
});

describe("runConversation (llm:before-call hooks)", () => {
  it("subscriber mutation of request is visible to llm:complete and llm:request", async () => {
    const { events } = makeEmit();
    let captured: any;
    const emit = async (name: string, payload?: any) => {
      events.push({ name, payload });
      if (name === "llm:before-call") {
        payload.request.model = "mutated";
        payload.request.systemPrompt = "mutated-sp";
      }
    };
    const llm = makeLlm([[{ type: "done", response: { content: "ok", finishReason: "stop" } }]]);
    llm.complete = (async function* (req: any) {
      captured = req;
      yield { type: "done", response: { content: "ok", finishReason: "stop" } };
    }) as any;
    const deps = makeDeps({ emit, llmComplete: llm });
    await runConversation({ systemPrompt: "orig", messages: [{ role: "user", content: "x" }], model: "orig-model" }, deps);
    expect(captured.model).toBe("mutated");
    expect(captured.systemPrompt).toBe("mutated-sp");
    const reqEv = events.find(e => e.name === "llm:request")!;
    expect(reqEv.payload.request.model).toBe("mutated");
    expect(reqEv.payload.request.systemPrompt).toBe("mutated-sp");
  });

  it("request.cancelled=true short-circuits: no llm:complete call, turn ends with reason=complete", async () => {
    const { events } = makeEmit();
    const llmCalls: any[] = [];
    const emit = async (name: string, payload?: any) => {
      events.push({ name, payload });
      if (name === "llm:before-call") payload.request.cancelled = true;
    };
    const llm = {
      async *complete(req: any) {
        llmCalls.push(req);
        yield { type: "done", response: { content: "should-not-happen", finishReason: "stop" } } as any;
      },
      async listModels() { return []; },
    } as any;
    const deps = makeDeps({ emit, llmComplete: llm });
    const out = await runConversation({ systemPrompt: "s", messages: [{ role: "user", content: "x" }] }, deps);
    expect(llmCalls.length).toBe(0);
    expect(out.messages).toEqual([{ role: "user", content: "x" }]); // no assistant appended
    const names = events.map(e => e.name);
    expect(names).not.toContain("llm:request");
    expect(names).not.toContain("llm:done");
    const endEv = events.find(e => e.name === "turn:end")!;
    expect(endEv.payload.reason).toBe("complete");
  });
});
