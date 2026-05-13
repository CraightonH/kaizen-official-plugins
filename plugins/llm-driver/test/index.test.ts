import { describe, it, expect, mock } from "bun:test";
import plugin from "../index.ts";
import type { ChatMessage, LLMStreamEvent } from "llm-contracts/public";
import type { SessionsStoreService, TurnHandle } from "llm-contracts/public";

function makeUi(lines: string[]) {
  const out: string[] = [];
  let i = 0;
  return {
    out,
    readInput: async () => i < lines.length ? lines[i++]! : "",
    setBusy: mock((_b: boolean, _m?: string) => {}),
    setBusyTiming: mock((_s: number) => {}),
    writeOutput: (s: string) => out.push(s),
    writeNotice: (s: string) => out.push(`[notice]${s}`),
  };
}

function makeLlm(events: LLMStreamEvent[][]) {
  let i = 0;
  return {
    async *complete() {
      const evs = events[i++] ?? [];
      for (const e of evs) yield e;
    },
    async listModels() { return []; },
  };
}

function makeSessions(): SessionsStoreService {
  let next = 0;
  const messages = new Map<string, ChatMessage[]>();
  const open = new Map<string, ChatMessage[]>();
  return {
    async create() {
      const id = `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}`;
      messages.set(id, []);
      return { id, harness: "h", metadata: {}, createdAt: next, pluginFingerprint: [] };
    },
    async load(id: string) {
      if (!messages.has(id)) throw new Error("not found");
      return { id, harness: "h", metadata: {}, createdAt: 1, pluginFingerprint: [] };
    },
    async exists(id: string) { return messages.has(id); },
    async getMessages(id: string) {
      return [...(messages.get(id) ?? []), ...(open.get(id) ?? [])];
    },
    beginTurn(id: string, turnId: string): TurnHandle {
      if (open.has(id)) throw new Error("already open");
      const buffer: ChatMessage[] = [];
      open.set(id, buffer);
      return {
        turnId,
        append: (msg) => buffer.push(msg),
        commit: async () => {
          messages.set(id, [...(messages.get(id) ?? []), ...buffer]);
          open.delete(id);
        },
        rollback: async () => { open.delete(id); },
        partialCommit: async () => { open.delete(id); },
      };
    },
    async list() { return []; },
    async delete() {},
    async *readEvents() {},
  } as any;
}

function makeCtx(deps: { ui: any; llm: any; cleared?: () => Promise<void>; cfg?: any }) {
  const handlers: Record<string, Function[]> = {};
  const events: { name: string; payload: any }[] = [];
  const provided: Record<string, unknown> = {};
  const sessions = makeSessions();
  return {
    log: mock(() => {}),
    config: deps.cfg ?? { defaultSystemPrompt: "sp" },
    defineService: mock(() => {}),
    provideService: (name: string, impl: unknown) => { provided[name] = impl; },
    consumeService: mock(() => {}),
    defineEvent: mock(() => {}),
    useService: (name: string) => {
      if (name === "ui:channel") return deps.ui;
      if (name === "llm:complete") return deps.llm;
      if (name === "sessions:store") return sessions;
      throw new Error(`useService: no provider for '${name}'`);
    },
    on: (name: string, fn: Function) => {
      (handlers[name] ??= []).push(fn);
      return () => { handlers[name] = (handlers[name] ?? []).filter(f => f !== fn); };
    },
    emit: async (name: string, payload?: any) => {
      events.push({ name, payload });
      for (const fn of handlers[name] ?? []) await fn(payload);
    },
    handlers,
    events,
    provided,
    sessions,
  } as any;
}

describe("llm-driver index", () => {
  it("metadata + setup defines + provides driver:run-conversation", async () => {
    expect(plugin.name).toBe("llm-driver");
    expect(plugin.driver).toBe(true);
    expect(plugin.config?.defaults).toEqual({ defaultSystemPrompt: "" });
    expect(plugin.config?.schema).toMatchObject({
      type: "object",
      properties: { defaultSystemPrompt: { type: "string" } },
    });
    expect(plugin.services?.consumes).toEqual([
      "events:vocabulary",
      "ui:channel",
      "llm:complete",
      "sessions:store",
    ]);
    const ctx = makeCtx({ ui: makeUi([]), llm: makeLlm([]) });
    await plugin.setup!(ctx);
    expect(ctx.provided["driver:run-conversation"]).toBeDefined();
    expect(typeof (ctx.provided["driver:run-conversation"] as any).runConversation).toBe("function");
  });

  it("interactive loop happy path: two turns then exit", async () => {
    const ui = makeUi(["hello", "again", ""]);
    const llm = makeLlm([
      [{ type: "done", response: { content: "hi-1", finishReason: "stop" } }],
      [{ type: "done", response: { content: "hi-2", finishReason: "stop" } }],
    ]);
    const ctx = makeCtx({ ui, llm });
    await plugin.setup!(ctx);
    await plugin.start!(ctx);
    const names = ctx.events.map((e: any) => e.name);
    expect(names[0]).toBe("harness:start");
    expect(names).toContain("session:active-changed");
    expect(names.at(-1)).toBe("harness:end");
    const turnStarts = ctx.events.filter((e: any) => e.name === "turn:start");
    expect(turnStarts.length).toBe(2);
    for (const ts of turnStarts) expect(ts.payload.trigger).toBe("user");
    const turnEnds = ctx.events.filter((e: any) => e.name === "turn:end");
    expect(turnEnds.length).toBe(2);
    for (const te of turnEnds) expect(te.payload.reason).toBe("complete");
  });

  it("input:handled short-circuit skips dispatch and the loop reads the next line", async () => {
    const ui = makeUi(["/help", "real", ""]);
    const llm = makeLlm([
      [{ type: "done", response: { content: "real-resp", finishReason: "stop" } }],
    ]);
    const ctx = makeCtx({ ui, llm });
    // Subscribe BEFORE setup to ensure our handler sees input:submit.
    ctx.on("input:submit", async (payload: any) => {
      if (payload.text === "/help") await ctx.emit("input:handled", { by: "test" });
    });
    await plugin.setup!(ctx);
    await plugin.start!(ctx);
    const turnStarts = ctx.events.filter((e: any) => e.name === "turn:start");
    expect(turnStarts.length).toBe(1); // only the second line dispatched
    const userMsgs = ctx.events.filter((e: any) => e.name === "conversation:user-message");
    expect(userMsgs.length).toBe(1);
    expect(userMsgs[0].payload.message.content).toBe("real");
  });

  it("recoverable LLM error rolls back messages so next turn starts clean", async () => {
    const ui = makeUi(["fail", "ok", ""]);
    const llm = makeLlm([
      [{ type: "error", message: "boom" }],
      [{ type: "done", response: { content: "ok-resp", finishReason: "stop" } }],
    ]);
    const ctx = makeCtx({ ui, llm });
    await plugin.setup!(ctx);
    await plugin.start!(ctx);
    const ends = ctx.events.filter((e: any) => e.name === "turn:end");
    expect(ends.map((e: any) => e.payload.reason)).toEqual(["error", "complete"]);
    expect(ui.out).toContain("[notice]error: boom");
    // After rollback the second turn's outgoing request should NOT include the failed
    // user message + assistant from turn 1. Verify via the llm:request snapshot.
    const reqs = ctx.events.filter((e: any) => e.name === "llm:request");
    // Two requests fired (one per turn). Second request's messages should be just [user("ok")].
    expect(reqs.length).toBe(2);
    expect(reqs[1].payload.request.messages.map((m: any) => m.content)).toEqual(["ok"]);
  });

  it("session:active-changed switches the active transcript", async () => {
    const ui = makeUi(["one", "two", ""]);
    const llm = makeLlm([
      [{ type: "done", response: { content: "r1", finishReason: "stop" } }],
      [{ type: "done", response: { content: "r2", finishReason: "stop" } }],
    ]);
    const ctx = makeCtx({ ui, llm });
    await plugin.setup!(ctx);
    ctx.on("input:submit", async (p: any) => {
      if (p.text === "two") {
        const next = await ctx.sessions.create({});
        await ctx.emit("session:active-changed", { from: "old", to: next.id });
        await ctx.emit("conversation:cleared", { from: "old", to: next.id });
      }
    });
    await plugin.start!(ctx);
    const reqs = ctx.events.filter((e: any) => e.name === "llm:request");
    expect(reqs.length).toBe(2);
    // Second request's outgoing messages start fresh, contain only the new user line.
    expect(reqs[1].payload.request.messages.map((m: any) => m.content)).toEqual(["two"]);
  });

  it("driver:run-conversation service emits turn:start with trigger=agent and parentTurnId", async () => {
    const llm = makeLlm([
      [{ type: "done", response: { content: "child-final", finishReason: "stop" } }],
    ]);
    const ctx = makeCtx({ ui: makeUi([]), llm });
    await plugin.setup!(ctx);
    const svc = ctx.provided["driver:run-conversation"] as any;
    const session = await ctx.sessions.create({});
    const out = await svc.runConversation({
      systemPrompt: "agent-sp",
      sessionId: session.id,
      userMessage: { role: "user", content: "go" },
      parentTurnId: "turn_parent",
    });
    expect(out.finalMessage.content).toBe("child-final");
    const startEv = ctx.events.find((e: any) => e.name === "turn:start")!;
    expect(startEv.payload.trigger).toBe("agent");
    expect(startEv.payload.parentTurnId).toBe("turn_parent");
  });
});
