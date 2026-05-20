import { describe, it, expect, mock } from "bun:test";
import { makeDispatchTool } from "../dispatch.ts";
import { makeRegistry, makeRegistryHandle } from "../registry.ts";
import { makeTurnTracker } from "../turn-tracker.ts";
import type { InternalAgentManifest } from "../frontmatter.ts";

function m(name: string): InternalAgentManifest {
  return {
    name,
    description: `agent ${name}`,
    systemPrompt: `you are ${name}`,
    toolFilter: { names: ["read_*"] },
    sourcePath: "/x",
    scope: "user",
  };
}

function makeCtx(turnId = "t-parent") {
  const events: { event: string; payload: any }[] = [];
  return {
    events,
    signal: new AbortController().signal,
    callId: "c1",
    turnId,
    sessionId: "parent-session",
    log: () => {},
    emit: async (e: string, p: any) => { events.push({ event: e, payload: p }); },
  } as any;
}

function makeSessions() {
  const records = new Map<string, any>();
  records.set("parent-session", { id: "parent-session", harness: "h", metadata: {}, createdAt: 1, pluginFingerprint: [] });
  return {
    records,
    createCalls: [] as any[],
    async create(opts: any) {
      this.createCalls.push(opts);
      const id = `${opts.parentSessionId}/${opts.childId}`;
      const record = { id, harness: "h", parentSessionId: opts.parentSessionId, agentName: opts.agentName, model: opts.model, metadata: {}, createdAt: 1, pluginFingerprint: [] };
      records.set(id, record);
      return record;
    },
    async load(id: string) {
      const record = records.get(id);
      if (!record) throw new Error("not found");
      return record;
    },
    async exists(id: string) {
      return records.has(id);
    },
    async getMessages() { return []; },
    beginTurn() { throw new Error("not needed"); },
    async list() { return Array.from(records.values()); },
    async delete() {},
    async *readEvents() {},
  } as any;
}

describe("dispatch_agent", () => {
  it("happy path: invokes runConversation with manifest prompt and parentTurnId", async () => {
    const reg = makeRegistryHandle(makeRegistry([m("code-reviewer")]));
    const tracker = makeTurnTracker();
    tracker.onTurnStart({ turnId: "t-parent", trigger: "user" });
    const driver = {
      runConversation: mock(async (input: any) => ({
        finalMessage: { role: "assistant" as const, content: "RESULT" },
        usage: { promptTokens: 1, completionTokens: 1 },
      })),
    };
    const sessions = makeSessions();
    const tool = makeDispatchTool({
      registry: reg, tracker, driver,
      sessions,
      maxDepth: 3,
      hasSkills: () => false,
    });
    const ctx = makeCtx();
    const result = await tool.handler({ agent_name: "code-reviewer", prompt: "look at file X", session_id: "review-A" }, ctx);
    expect(result).toBe("RESULT");
    expect(driver.runConversation).toHaveBeenCalledTimes(1);
    const arg = (driver.runConversation as any).mock.calls[0][0];
    expect(arg.systemPrompt).toBe("you are code-reviewer");
    expect(arg.sessionId).toBe("parent-session/review-A");
    expect(arg.userMessage).toEqual({ role: "user", content: "look at file X" });
    expect(arg.parentTurnId).toBe("t-parent");
    // Always-on dispatch_agent must be present in the filter:
    expect(arg.toolFilter.names).toContain("dispatch_agent");
    // Manifest filter preserved:
    expect(arg.toolFilter.names).toContain("read_*");
  });

  it("includes load_skill when skills service available", async () => {
    const reg = makeRegistryHandle(makeRegistry([m("a")]));
    const tracker = makeTurnTracker();
    tracker.onTurnStart({ turnId: "t-parent", trigger: "user" });
    const driver = { runConversation: async () => ({ finalMessage: { role: "assistant" as const, content: "" }, usage: { promptTokens: 0, completionTokens: 0 } }) };
    const tool = makeDispatchTool({ registry: reg, tracker, driver, sessions: makeSessions(), maxDepth: 3, hasSkills: () => true });
    let captured: any;
    (driver as any).runConversation = async (input: any) => { captured = input; return { finalMessage: { role: "assistant" as const, content: "" }, usage: { promptTokens: 0, completionTokens: 0 } }; };
    await tool.handler({ agent_name: "a", prompt: "p" }, makeCtx());
    expect(captured.toolFilter.names).toContain("load_skill");
  });

  it("unknown agent throws tool error with Spec 11 message", async () => {
    const reg = makeRegistryHandle(makeRegistry([m("a"), m("b")]));
    const tracker = makeTurnTracker();
    tracker.onTurnStart({ turnId: "t-parent", trigger: "user" });
    const tool = makeDispatchTool({ registry: reg, tracker, driver: { runConversation: async () => ({} as any) }, sessions: makeSessions(), maxDepth: 3, hasSkills: () => false });
    await expect(tool.handler({ agent_name: "ghost", prompt: "p" }, makeCtx())).rejects.toThrow(/Unknown agent 'ghost'.*Known: a, b/);
  });

  it("depth limit returns canonical error", async () => {
    const reg = makeRegistryHandle(makeRegistry([m("a")]));
    const tracker = makeTurnTracker();
    tracker.onTurnStart({ turnId: "t0", trigger: "user" });
    tracker.onTurnStart({ turnId: "t1", trigger: "agent", parentTurnId: "t0" });
    tracker.onTurnStart({ turnId: "t2", trigger: "agent", parentTurnId: "t1" });
    tracker.onTurnStart({ turnId: "t3", trigger: "agent", parentTurnId: "t2" });
    const tool = makeDispatchTool({ registry: reg, tracker, driver: { runConversation: async () => ({} as any) }, sessions: makeSessions(), maxDepth: 3, hasSkills: () => false });
    const ctx = makeCtx("t3");
    await expect(tool.handler({ agent_name: "a", prompt: "p" }, ctx)).rejects.toThrow(/depth limit reached \(max=3\)/);
  });

  it("propagates parent's signal as input.signal", async () => {
    const reg = makeRegistryHandle(makeRegistry([m("a")]));
    const tracker = makeTurnTracker();
    tracker.onTurnStart({ turnId: "tp", trigger: "user" });
    let captured: AbortSignal | undefined;
    const driver = { runConversation: async (input: any) => { captured = input.signal; return { finalMessage: { role: "assistant" as const, content: "" }, usage: { promptTokens: 0, completionTokens: 0 } }; } };
    const tool = makeDispatchTool({ registry: reg, tracker, driver, sessions: makeSessions(), maxDepth: 3, hasSkills: () => false });
    const ac = new AbortController();
    const ctx = { ...makeCtx("tp"), signal: ac.signal };
    await tool.handler({ agent_name: "a", prompt: "p" }, ctx as any);
    expect(captured).toBe(ac.signal);
  });

  it("AbortError from runConversation surfaces as cancelled tool error", async () => {
    const reg = makeRegistryHandle(makeRegistry([m("a")]));
    const tracker = makeTurnTracker();
    tracker.onTurnStart({ turnId: "tp", trigger: "user" });
    const driver = { runConversation: async () => { const e: any = new Error("aborted"); e.name = "AbortError"; throw e; } };
    const tool = makeDispatchTool({ registry: reg, tracker, driver, sessions: makeSessions(), maxDepth: 3, hasSkills: () => false });
    await expect(tool.handler({ agent_name: "a", prompt: "p" }, makeCtx("tp"))).rejects.toThrow(/Agent 'a' cancelled/);
  });

  it("non-Abort errors are wrapped with 'failed: <inner>'", async () => {
    const reg = makeRegistryHandle(makeRegistry([m("a")]));
    const tracker = makeTurnTracker();
    tracker.onTurnStart({ turnId: "tp", trigger: "user" });
    const driver = { runConversation: async () => { throw new Error("boom"); } };
    const tool = makeDispatchTool({ registry: reg, tracker, driver, sessions: makeSessions(), maxDepth: 3, hasSkills: () => false });
    await expect(tool.handler({ agent_name: "a", prompt: "p" }, makeCtx("tp"))).rejects.toThrow(/Agent 'a' failed: boom/);
  });

  it("rejects malformed inputs", async () => {
    const reg = makeRegistryHandle(makeRegistry([m("a")]));
    const tracker = makeTurnTracker();
    tracker.onTurnStart({ turnId: "tp", trigger: "user" });
    const tool = makeDispatchTool({ registry: reg, tracker, driver: { runConversation: async () => ({} as any) }, sessions: makeSessions(), maxDepth: 3, hasSkills: () => false });
    await expect(tool.handler({ agent_name: 1, prompt: "p" } as any, makeCtx("tp"))).rejects.toThrow();
    await expect(tool.handler({ agent_name: "a" } as any, makeCtx("tp"))).rejects.toThrow();
  });

  it("emits agent:dispatch:start before runConversation and agent:dispatch:end after", async () => {
    const reg = makeRegistryHandle(makeRegistry([m("a")]));
    const tracker = makeTurnTracker();
    tracker.onTurnStart({ turnId: "tp", trigger: "user" });
    const order: string[] = [];
    const driver = {
      runConversation: async () => {
        order.push("runConversation");
        return { finalMessage: { role: "assistant" as const, content: "ok" }, usage: { promptTokens: 0, completionTokens: 0 } };
      },
    };
    const emitted: { event: string; payload: any }[] = [];
    const emit = async (event: string, payload: unknown) => {
      emitted.push({ event, payload });
      if (event === "agent:dispatch:start") order.push("start");
      if (event === "agent:dispatch:end") order.push("end");
    };
    const tool = makeDispatchTool({ registry: reg, tracker, driver, sessions: makeSessions(), maxDepth: 3, hasSkills: () => false, emit });
    const ctx = { ...makeCtx("tp"), callId: "call-XYZ" };
    await tool.handler({ agent_name: "a", prompt: "p", session_id: "thread" }, ctx as any);
    const start = emitted.find((e) => e.event === "agent:dispatch:start");
    const end = emitted.find((e) => e.event === "agent:dispatch:end");
    expect(start?.payload).toMatchObject({ callId: "call-XYZ", sessionId: "parent-session/thread", agentName: "a" });
    expect(end?.payload).toMatchObject({ callId: "call-XYZ", sessionId: "parent-session/thread" });
    expect(order).toEqual(["start", "runConversation", "end"]);
  });

  it("emits agent:dispatch:end even when runConversation throws", async () => {
    const reg = makeRegistryHandle(makeRegistry([m("a")]));
    const tracker = makeTurnTracker();
    tracker.onTurnStart({ turnId: "tp", trigger: "user" });
    const driver = { runConversation: async () => { throw new Error("boom"); } };
    const emitted: { event: string; payload: any }[] = [];
    const emit = async (event: string, payload: unknown) => { emitted.push({ event, payload }); };
    const tool = makeDispatchTool({ registry: reg, tracker, driver, sessions: makeSessions(), maxDepth: 3, hasSkills: () => false, emit });
    await expect(tool.handler({ agent_name: "a", prompt: "p" }, makeCtx("tp"))).rejects.toThrow(/Agent 'a' failed/);
    expect(emitted.find((e) => e.event === "agent:dispatch:end")).toBeDefined();
  });

  it("emits status:item-update before runConversation and status:item-clear after", async () => {
    const reg = makeRegistryHandle(makeRegistry([m("a")]));
    const tracker = makeTurnTracker();
    tracker.onTurnStart({ turnId: "tp", trigger: "user" });
    const driver = { runConversation: async () => ({ finalMessage: { role: "assistant" as const, content: "ok" }, usage: { promptTokens: 0, completionTokens: 0 } }) };
    const emitted: { event: string; payload: any }[] = [];
    const emit = async (event: string, payload: unknown) => { emitted.push({ event, payload }); };
    const tool = makeDispatchTool({ registry: reg, tracker, driver, sessions: makeSessions(), maxDepth: 3, hasSkills: () => false, emit });
    await tool.handler({ agent_name: "a", prompt: "p" }, makeCtx("tp"));
    const updateEvent = emitted.find((e) => e.event === "status:item-update");
    const clearEvent = emitted.find((e) => e.event === "status:item-clear");
    expect(updateEvent?.payload).toMatchObject({ key: "agents.active", value: "a" });
    expect(clearEvent?.payload).toMatchObject({ key: "agents.active" });
  });

  it("same session_id continues existing sub-session", async () => {
    const reg = makeRegistryHandle(makeRegistry([m("a")]));
    const tracker = makeTurnTracker();
    tracker.onTurnStart({ turnId: "tp", trigger: "user" });
    const sessions = makeSessions();
    sessions.records.set("parent-session/thread", {
      id: "parent-session/thread",
      harness: "h",
      parentSessionId: "parent-session",
      agentName: "a",
      metadata: {},
      createdAt: 1,
      pluginFingerprint: [],
    });
    let captured: any;
    const driver = { runConversation: async (input: any) => { captured = input; return { finalMessage: { role: "assistant" as const, content: "ok" }, usage: { promptTokens: 0, completionTokens: 0 } }; } };
    const tool = makeDispatchTool({ registry: reg, tracker, driver, sessions, maxDepth: 3, hasSkills: () => false });
    await tool.handler({ agent_name: "a", prompt: "p", session_id: "thread" }, makeCtx("tp"));
    expect(captured.sessionId).toBe("parent-session/thread");
    expect(sessions.createCalls).toHaveLength(0);
  });

  it("existing session_id under a different agent throws", async () => {
    const reg = makeRegistryHandle(makeRegistry([m("a")]));
    const tracker = makeTurnTracker();
    tracker.onTurnStart({ turnId: "tp", trigger: "user" });
    const sessions = makeSessions();
    sessions.records.set("parent-session/thread", {
      id: "parent-session/thread",
      harness: "h",
      parentSessionId: "parent-session",
      agentName: "other",
      metadata: {},
      createdAt: 1,
      pluginFingerprint: [],
    });
    const tool = makeDispatchTool({ registry: reg, tracker, driver: { runConversation: async () => ({} as any) }, sessions, maxDepth: 3, hasSkills: () => false });
    await expect(tool.handler({ agent_name: "a", prompt: "p", session_id: "thread" }, makeCtx("tp"))).rejects.toThrow(/different agent/);
  });

  it("omitted session_id creates a persisted oneshot child session", async () => {
    const reg = makeRegistryHandle(makeRegistry([m("a")]));
    const tracker = makeTurnTracker();
    tracker.onTurnStart({ turnId: "tp", trigger: "user" });
    const sessions = makeSessions();
    let captured: any;
    const driver = { runConversation: async (input: any) => { captured = input; return { finalMessage: { role: "assistant" as const, content: "ok" }, usage: { promptTokens: 0, completionTokens: 0 } }; } };
    const tool = makeDispatchTool({ registry: reg, tracker, driver, sessions, maxDepth: 3, hasSkills: () => false });
    await tool.handler({ agent_name: "a", prompt: "p" }, makeCtx("tp"));
    expect(captured.sessionId).toMatch(/^parent-session\/oneshot-/);
    expect(sessions.createCalls[0]).toMatchObject({ parentSessionId: "parent-session", agentName: "a" });
  });

  it("requires turnId and sessionId in ToolExecutionContext", async () => {
    const reg = makeRegistryHandle(makeRegistry([m("a")]));
    const tracker = makeTurnTracker();
    tracker.onTurnStart({ turnId: "tp", trigger: "user" });
    const tool = makeDispatchTool({ registry: reg, tracker, driver: { runConversation: async () => ({} as any) }, sessions: makeSessions(), maxDepth: 3, hasSkills: () => false });
    await expect(tool.handler({ agent_name: "a", prompt: "p" }, { ...makeCtx("tp"), sessionId: undefined } as any)).rejects.toThrow(/sessionId missing/);
    await expect(tool.handler({ agent_name: "a", prompt: "p" }, { ...makeCtx("tp"), turnId: undefined } as any)).rejects.toThrow(/turnId missing/);
  });

  it("invalid session_id is rejected before store lookup", async () => {
    const reg = makeRegistryHandle(makeRegistry([m("a")]));
    const tracker = makeTurnTracker();
    tracker.onTurnStart({ turnId: "tp", trigger: "user" });
    const sessions = makeSessions();
    let existsCalled = false;
    sessions.exists = async () => { existsCalled = true; return false; };
    const tool = makeDispatchTool({ registry: reg, tracker, driver: { runConversation: async () => ({} as any) }, sessions, maxDepth: 3, hasSkills: () => false });
    await expect(tool.handler({ agent_name: "a", prompt: "p", session_id: "bad/slash" }, makeCtx("tp"))).rejects.toThrow(/session_id/);
    expect(existsCalled).toBe(false);
  });
});

describe("dispatch exclude pass-through and always-on strip", () => {
  it("passes excludeNames and excludeTags through to the driver", async () => {
    const driverCalls: any[] = [];
    const fakeDriver = { runConversation: async (input: any) => { driverCalls.push(input); return { finalMessage: { role: "assistant" as const, content: "" }, usage: { promptTokens: 0, completionTokens: 0 } }; } };
    const reg = makeRegistryHandle(makeRegistry([m("agent-with-deny")]));
    (reg.getInternal("agent-with-deny") as any).toolFilter = {
      names: ["read_file"],
      excludeNames: ["edit_file"],
      excludeTags: ["destructive"],
    };
    const tracker = makeTurnTracker();
    tracker.onTurnStart({ turnId: "t-parent", trigger: "user" });
    const dispatch = makeDispatchTool({
      registry: reg,
      tracker,
      driver: fakeDriver as any,
      sessions: makeSessions(),
      maxDepth: 4,
      hasSkills: () => false,
      emit: async () => {},
    });
    await dispatch.handler({ agent_name: "agent-with-deny", prompt: "hi" }, makeCtx());
    expect(driverCalls).toHaveLength(1);
    const passedFilter = driverCalls[0].toolFilter;
    expect(passedFilter.excludeNames).toEqual(["edit_file"]);
    expect(passedFilter.excludeTags).toEqual(["destructive"]);
  });

  it("strips always-on tool names from excludeNames before passing to driver", async () => {
    const driverCalls: any[] = [];
    const fakeDriver = { runConversation: async (input: any) => { driverCalls.push(input); return { finalMessage: { role: "assistant" as const, content: "" }, usage: { promptTokens: 0, completionTokens: 0 } }; } };
    const reg = makeRegistryHandle(makeRegistry([m("self-denying")]));
    (reg.getInternal("self-denying") as any).toolFilter = {
      excludeNames: ["dispatch_agent", "load_skill", "edit_file"],
    };
    const tracker = makeTurnTracker();
    tracker.onTurnStart({ turnId: "t-parent", trigger: "user" });
    const dispatch = makeDispatchTool({
      registry: reg,
      tracker,
      driver: fakeDriver as any,
      sessions: makeSessions(),
      maxDepth: 4,
      hasSkills: () => true,
      emit: async () => {},
    });
    await dispatch.handler({ agent_name: "self-denying", prompt: "hi" }, makeCtx());
    const passedFilter = driverCalls[0].toolFilter;
    expect(passedFilter.excludeNames).toEqual(["edit_file"]);
    expect(passedFilter.names).toContain("dispatch_agent");
    expect(passedFilter.names).toContain("load_skill");
  });

  it("defaults excludeNames/excludeTags to empty arrays when the manifest declares none", async () => {
    const driverCalls: any[] = [];
    const fakeDriver = { runConversation: async (input: any) => { driverCalls.push(input); return { finalMessage: { role: "assistant" as const, content: "" }, usage: { promptTokens: 0, completionTokens: 0 } }; } };
    const reg = makeRegistryHandle(makeRegistry([m("plain")]));
    const tracker = makeTurnTracker();
    tracker.onTurnStart({ turnId: "t-parent", trigger: "user" });
    const dispatch = makeDispatchTool({
      registry: reg,
      tracker,
      driver: fakeDriver as any,
      sessions: makeSessions(),
      maxDepth: 4,
      hasSkills: () => false,
      emit: async () => {},
    });
    await dispatch.handler({ agent_name: "plain", prompt: "hi" }, makeCtx());
    const passedFilter = driverCalls[0].toolFilter;
    expect(passedFilter.excludeNames).toEqual([]);
    expect(passedFilter.excludeTags).toEqual([]);
  });
});
