import { describe, it, expect, mock } from "bun:test";
import { runConversation, type RunConversationDeps, type ToolDispatchStrategy, type ToolsRegistryService } from "../loop.ts";
import { makeIdGen } from "../ids.ts";
import type { ChatMessage, LLMCompleteService, LLMStreamEvent } from "llm-events/public";
import type { SessionsStoreService, TurnHandle } from "llm-session-manager/public";

function makeLlm(events: LLMStreamEvent[][]): LLMCompleteService & { calls: any[] } {
  let i = 0;
  const calls: any[] = [];
  return {
    calls,
    async *complete(req: any, opts: any) {
      calls.push({ req, opts });
      for (const event of events[i++] ?? []) yield event;
    },
    async listModels() { return []; },
  } as any;
}

interface RecEvent { name: string; payload: any; }
function makeEmit(): { emit: (n: string, p?: any) => Promise<void>; events: RecEvent[] } {
  const events: RecEvent[] = [];
  return {
    events,
    emit: async (name, payload) => { events.push({ name, payload }); },
  };
}

function makeSessions(initial: ChatMessage[] = []): SessionsStoreService & { committed: ChatMessage[] } {
  let open: { buffer: ChatMessage[]; closed: boolean } | null = null;
  const store = {
    committed: initial.slice(),
    async create() { throw new Error("not needed"); },
    async load() { return {} as any; },
    async exists() { return true; },
    async getMessages() {
      return open ? [...store.committed, ...open.buffer] : store.committed.slice();
    },
    beginTurn(_id: string, turnId: string): TurnHandle {
      if (open) throw new Error("already open");
      const state = { buffer: [] as ChatMessage[], closed: false };
      open = state;
      return {
        turnId,
        append(msg) {
          if (state.closed) throw new Error("closed");
          state.buffer.push(msg);
        },
        async commit() {
          if (state.closed) return;
          store.committed.push(...state.buffer);
          state.closed = true;
          if (open === state) open = null;
        },
        async rollback() {
          if (state.closed) return;
          state.closed = true;
          if (open === state) open = null;
        },
      };
    },
    async list() { return []; },
    async delete() {},
    async *readEvents() {},
  } as SessionsStoreService & { committed: ChatMessage[] };
  return store;
}

function makeDeps(overrides: Partial<RunConversationDeps> = {}): RunConversationDeps {
  const { emit } = makeEmit();
  return {
    emit,
    llmComplete: makeLlm([[{ type: "done", response: { content: "ok", finishReason: "stop" } }]]),
    registry: undefined,
    strategy: undefined,
    sessions: makeSessions(),
    log: mock(() => {}),
    idGen: makeIdGen(["turn_test_1", "turn_test_2"]),
    defaultSystemPrompt: "default-sp",
    ...overrides,
  };
}

describe("runConversation", () => {
  it("owned turn: appends user and assistant through the session store", async () => {
    const { emit, events } = makeEmit();
    const sessions = makeSessions();
    const llm = makeLlm([[{ type: "token", delta: "hi" }, { type: "done", response: { content: "hi", finishReason: "stop" } }]]);
    const deps = makeDeps({ emit, sessions, llmComplete: llm });

    const out = await runConversation({
      systemPrompt: "sys",
      sessionId: "session-1",
      userMessage: { role: "user", content: "yo" },
      model: "m",
    }, deps);

    expect(events.map((e) => e.name)).toEqual([
      "conversation:user-message",
      "turn:start",
      "llm:before-call",
      "llm:request",
      "llm:token",
      "llm:done",
      "turn:end",
    ]);
    expect(events.find((e) => e.name === "turn:start")!.payload).toMatchObject({
      turnId: "turn_test_1",
      sessionId: "session-1",
      trigger: "agent",
    });
    expect(sessions.committed).toEqual([
      { role: "user", content: "yo" },
      { role: "assistant", content: "hi" },
    ]);
    expect(out.finalMessage).toEqual({ role: "assistant", content: "hi" });
  });

  it("existing-turn mode does not emit or commit lifecycle events", async () => {
    const { emit, events } = makeEmit();
    const sessions = makeSessions();
    const handle = sessions.beginTurn("session-1", "turn-external");
    handle.append({ role: "user", content: "outer" });
    const deps = makeDeps({ emit, sessions });

    await runConversation({
      systemPrompt: "sys",
      sessionId: "session-1",
      externalTurnId: "turn-external",
      turnHandle: handle,
    }, deps);

    expect(events.map((e) => e.name)).not.toContain("turn:start");
    expect(events.map((e) => e.name)).not.toContain("turn:end");
    expect(await sessions.getMessages("session-1")).toHaveLength(2);
    expect(sessions.committed).toEqual([]);
    await handle.commit();
    expect(sessions.committed.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("turn:start carries parentTurnId and llm events carry turn/session ids", async () => {
    const { emit, events } = makeEmit();
    const deps = makeDeps({ emit });
    await runConversation({
      systemPrompt: "sys",
      sessionId: "session-1",
      userMessage: { role: "user", content: "x" },
      parentTurnId: "turn-parent",
    }, deps);
    expect(events.find((e) => e.name === "turn:start")!.payload).toMatchObject({
      parentTurnId: "turn-parent",
      sessionId: "session-1",
    });
    expect(events.find((e) => e.name === "llm:request")!.payload).toMatchObject({
      turnId: "turn_test_1",
      sessionId: "session-1",
    });
  });

  it("passes input.model through unchanged", async () => {
    const llm = makeLlm([[{ type: "done", response: { content: "", finishReason: "stop" } }]]);
    const deps = makeDeps({ llmComplete: llm });
    await runConversation({
      systemPrompt: "sys",
      sessionId: "session-1",
      userMessage: { role: "user", content: "x" },
    }, deps);
    expect(llm.calls[0].req.model).toBeUndefined();
  });

  it("llm:request payload is deep-frozen", async () => {
    const { emit, events } = makeEmit();
    const deps = makeDeps({ emit });
    await runConversation({
      systemPrompt: "sys",
      sessionId: "session-1",
      userMessage: { role: "user", content: "x" },
    }, deps);
    const reqEv = events.find((e) => e.name === "llm:request")!;
    expect(Object.isFrozen(reqEv.payload.request)).toBe(true);
    expect(Object.isFrozen(reqEv.payload.request.messages)).toBe(true);
  });

  it("LLM errors roll back owned turns and emit turn:error/end", async () => {
    const { emit, events } = makeEmit();
    const sessions = makeSessions();
    const llm = makeLlm([[{ type: "error", message: "boom" }]]);
    const deps = makeDeps({ emit, sessions, llmComplete: llm });
    await expect(runConversation({
      systemPrompt: "sys",
      sessionId: "session-1",
      userMessage: { role: "user", content: "x" },
    }, deps)).rejects.toThrow(/boom/);
    expect(sessions.committed).toEqual([]);
    expect(events.map((e) => e.name)).toContain("turn:error");
    expect(events.find((e) => e.name === "turn:end")!.payload.reason).toBe("error");
  });

  it("strategy loop appends tool messages, recalls LLM, and threads ids into strategy", async () => {
    const llm = makeLlm([
      [{ type: "done", response: { content: "use tool", finishReason: "tool_calls", toolCalls: [{ id: "c1", name: "f", arguments: {} }] } }],
      [{ type: "done", response: { content: "final", finishReason: "stop" } }],
    ]);
    const strategyCalls: any[] = [];
    const strategy: ToolDispatchStrategy = {
      prepareRequest: ({ availableTools }) => ({ tools: availableTools, systemPromptAppend: "[strategy]" }),
      handleResponse: async (input) => {
        strategyCalls.push(input);
        return strategyCalls.length === 1
          ? [{ role: "tool", content: "tool-result", toolCallId: "c1", name: "f" }]
          : [];
      },
    };
    const sessions = makeSessions();
    const deps = makeDeps({
      llmComplete: llm,
      sessions,
      registry: { list: () => [], invoke: async () => undefined } as ToolsRegistryService,
      strategy,
    });

    const out = await runConversation({
      systemPrompt: "sys",
      sessionId: "session-1",
      userMessage: { role: "user", content: "go" },
    }, deps);

    expect(sessions.committed.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[0].req.systemPrompt).toContain("[strategy]");
    expect(strategyCalls[0]).toMatchObject({ turnId: "turn_test_1", sessionId: "session-1" });
    expect(out.finalMessage.content).toBe("final");
  });

  it("aggregates usage across multiple LLM calls", async () => {
    const llm = makeLlm([
      [{ type: "done", response: { content: "a", finishReason: "tool_calls", toolCalls: [{ id: "c1", name: "f", arguments: {} }], usage: { promptTokens: 10, completionTokens: 2 } } }],
      [{ type: "done", response: { content: "b", finishReason: "stop", usage: { promptTokens: 12, completionTokens: 4 } } }],
    ]);
    let calls = 0;
    const strategy: ToolDispatchStrategy = {
      prepareRequest: () => ({}),
      handleResponse: async () => {
        calls++;
        return calls === 1 ? [{ role: "tool", content: "r", toolCallId: "c1", name: "f" }] : [];
      },
    };
    const deps = makeDeps({
      llmComplete: llm,
      registry: { list: () => [], invoke: async () => undefined } as ToolsRegistryService,
      strategy,
    });
    const out = await runConversation({
      systemPrompt: "sys",
      sessionId: "session-1",
      userMessage: { role: "user", content: "x" },
    }, deps);
    expect(out.usage).toEqual({ promptTokens: 22, completionTokens: 6 });
  });

  it("llm:before-call mutation is visible to the provider and llm:request", async () => {
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
    await runConversation({
      systemPrompt: "orig",
      sessionId: "session-1",
      userMessage: { role: "user", content: "x" },
      model: "orig-model",
    }, makeDeps({ emit, llmComplete: llm }));
    expect(captured.model).toBe("mutated");
    expect(captured.systemPrompt).toBe("mutated-sp");
    const reqEv = events.find((e) => e.name === "llm:request")!;
    expect(reqEv.payload.request.model).toBe("mutated");
    expect(reqEv.payload.request.systemPrompt).toBe("mutated-sp");
  });

  it("request.cancelled=true short-circuits without appending an assistant", async () => {
    const { events } = makeEmit();
    const sessions = makeSessions();
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
    const out = await runConversation({
      systemPrompt: "s",
      sessionId: "session-1",
      userMessage: { role: "user", content: "x" },
    }, makeDeps({ emit, sessions, llmComplete: llm }));
    expect(llmCalls).toHaveLength(0);
    expect(sessions.committed).toEqual([{ role: "user", content: "x" }]);
    expect(out.finalMessage).toEqual({ role: "user", content: "x" });
    expect(events.map((e) => e.name)).not.toContain("llm:request");
    expect(events.find((e) => e.name === "turn:end")!.payload.reason).toBe("complete");
  });
});
