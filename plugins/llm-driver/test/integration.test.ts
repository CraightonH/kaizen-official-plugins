// plugins/llm-driver/test/integration.test.ts
import { describe, it, expect, mock } from "bun:test";
import plugin from "../index.ts";
import type { ChatMessage } from "llm-contracts/public";

function makeSessions() {
  let next = 0;
  const messages = new Map<string, ChatMessage[]>();
  const open = new Map<string, ChatMessage[]>();
  return {
    async create() {
      const id = `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}`;
      messages.set(id, []);
      return { id, harness: "h", metadata: {}, createdAt: next, pluginFingerprint: [] };
    },
    async getMessages(id: string) { return [...(messages.get(id) ?? []), ...(open.get(id) ?? [])]; },
    beginTurn(id: string, turnId: string) {
      const buffer: ChatMessage[] = [];
      open.set(id, buffer);
      return {
        turnId,
        append: (msg: ChatMessage) => buffer.push(msg),
        commit: async () => { messages.set(id, [...(messages.get(id) ?? []), ...buffer]); open.delete(id); },
        rollback: async () => { open.delete(id); },
        partialCommit: async () => {
          const trimmed = [...buffer];
          const last = trimmed[trimmed.length - 1];
          if (last && last.role === "assistant" && Array.isArray(last.toolCalls) && last.toolCalls.length > 0) {
            trimmed.pop();
          }
          if (trimmed.length > 0) {
            messages.set(id, [...(messages.get(id) ?? []), ...trimmed]);
          }
          open.delete(id);
        },
      };
    },
    async load(id: string) { return { id, harness: "h", metadata: {}, createdAt: 1, pluginFingerprint: [] }; },
    async exists(id: string) { return messages.has(id); },
    async list() { return []; },
    async delete() {},
    async *readEvents() {},
  };
}

describe("llm-driver integration (synthetic llm:complete)", () => {
  it("session-level event sequence is exactly correct for a single turn", async () => {
    const handlers: Record<string, Function[]> = {};
    const events: { name: string; payload: any }[] = [];
    const ui = {
      i: 0,
      readInput: async function () { return this.i++ === 0 ? "hello" : ""; },
      setBusy: () => {},
      setBusyTiming: () => {},
      writeOutput: () => {},
      writeNotice: () => {},
    };
    const llm = {
      async *complete() {
        yield { type: "token", delta: "he" } as const;
        yield { type: "token", delta: "llo" } as const;
        yield { type: "done", response: { content: "hello", finishReason: "stop" } } as const;
      },
      async listModels() { return []; },
    };
    const sessions = makeSessions();
    const ctx: any = {
      log: () => {},
      config: { defaultSystemPrompt: "sp" },
      defineService: () => {},
      provideService: () => {},
      consumeService: () => {},
      defineEvent: () => {},
      useService: (n: string) => {
        if (n === "ui:channel") return ui;
        if (n === "llm:complete") return llm;
        if (n === "sessions:store") return sessions;
        // Optional services (config:store, prompt:registry, …) return
        // undefined so the topo-hint optional pattern in setup() can fall
        // back to defaults under the fake ctx.
        return undefined;
      },
      on: (n: string, fn: Function) => { (handlers[n] ??= []).push(fn); return () => {}; },
      emit: async (n: string, p?: any) => { events.push({ name: n, payload: p }); for (const fn of handlers[n] ?? []) await fn(p); },
    };
    await plugin.setup!(ctx);
    await plugin.start!(ctx);
    const seq = events.map(e => e.name);
    // Required ordering checkpoints (other events may interleave but these MUST appear in order):
    expect(seq[0]).toBe("harness:start");
    expect(seq).toContain("session:active-changed");
    expect(seq.indexOf("turn:start")).toBeGreaterThan(0);
    expect(seq.indexOf("llm:before-call")).toBeGreaterThan(seq.indexOf("turn:start"));
    expect(seq.indexOf("llm:request")).toBeGreaterThan(seq.indexOf("llm:before-call"));
    expect(seq.indexOf("llm:done")).toBeGreaterThan(seq.indexOf("llm:request"));
    expect(seq.indexOf("conversation:assistant-message")).toBeGreaterThan(seq.indexOf("llm:done"));
    expect(seq.indexOf("turn:end")).toBeGreaterThan(seq.indexOf("conversation:assistant-message"));
    expect(seq.at(-1)).toBe("harness:end");
  });

  it("driver runs a turn on session:handoff with autostart=true", async () => {
    const handlers: Record<string, Function[]> = {};
    const events: { name: string; payload: any }[] = [];
    let completeCalls = 0;
    const llm = {
      async *complete() {
        completeCalls++;
        yield { type: "token", delta: "hi" } as const;
        yield { type: "done", response: { content: "hi", finishReason: "stop" } } as const;
      },
      async listModels() { return []; },
    };
    const sessions = makeSessions();
    const ctx: any = {
      log: () => {},
      config: {},
      defineService: () => {},
      provideService: () => {},
      consumeService: () => {},
      defineEvent: () => {},
      useService: (n: string) => {
        if (n === "llm:complete") return llm;
        if (n === "sessions:store") return sessions;
        return undefined;
      },
      on: (n: string, fn: Function) => { (handlers[n] ??= []).push(fn); return () => {}; },
      emit: async (n: string, p?: any) => { events.push({ name: n, payload: p }); for (const fn of handlers[n] ?? []) await fn(p); },
    };
    await plugin.setup!(ctx);

    // Simulate session-manager: create new session with seeded user turn at tail.
    const newSession = await sessions.create();
    const handle = sessions.beginTurn(newSession.id, "seed-turn");
    handle.append({ role: "user", content: "seeded prompt" });
    await handle.commit();

    // Mirror real flow: active-changed fires before handoff.
    await ctx.emit("session:active-changed", { from: null, to: newSession.id, alias: null });
    await ctx.emit("session:handoff", { from: null, to: newSession.id, autostart: true });

    // Allow any outstanding microtasks/awaits in the subscriber to settle.
    await new Promise((r) => setTimeout(r, 10));

    expect(completeCalls).toBe(1);
    const msgs = await sessions.getMessages(newSession.id);
    expect(msgs.at(-1)?.role).toBe("assistant");
    const turnEnds = events.filter(e => e.name === "turn:end");
    expect(turnEnds.length).toBe(1);
    expect(turnEnds[0]!.payload.reason).toBe("complete");
  });

  it("driver no-ops on session:handoff with autostart=false", async () => {
    const handlers: Record<string, Function[]> = {};
    const events: { name: string; payload: any }[] = [];
    let completeCalls = 0;
    const llm = {
      async *complete() {
        completeCalls++;
        yield { type: "done", response: { content: "x", finishReason: "stop" } } as const;
      },
      async listModels() { return []; },
    };
    const sessions = makeSessions();
    const ctx: any = {
      log: () => {},
      config: {},
      defineService: () => {},
      provideService: () => {},
      consumeService: () => {},
      defineEvent: () => {},
      useService: (n: string) => {
        if (n === "llm:complete") return llm;
        if (n === "sessions:store") return sessions;
        return undefined;
      },
      on: (n: string, fn: Function) => { (handlers[n] ??= []).push(fn); return () => {}; },
      emit: async (n: string, p?: any) => { events.push({ name: n, payload: p }); for (const fn of handlers[n] ?? []) await fn(p); },
    };
    await plugin.setup!(ctx);

    const newSession = await sessions.create();
    const handle = sessions.beginTurn(newSession.id, "seed-turn");
    handle.append({ role: "user", content: "seeded prompt" });
    await handle.commit();

    await ctx.emit("session:active-changed", { from: null, to: newSession.id, alias: null });
    await ctx.emit("session:handoff", { from: null, to: newSession.id, autostart: false });

    await new Promise((r) => setTimeout(r, 10));

    expect(completeCalls).toBe(0);
    const turnStarts = events.filter(e => e.name === "turn:start");
    expect(turnStarts.length).toBe(0);
  });

  it("cancel during in-flight LLM call preserves the user message in the snapshot", async () => {
    const handlers: Record<string, Function[]> = {};
    const events: { name: string; payload: any }[] = [];
    const ui = {
      i: 0,
      readInput: async function () { return this.i++ === 0 ? "amend my request later" : ""; },
      setBusy: () => {},
      setBusyTiming: () => {},
      writeOutput: () => {},
      writeNotice: () => {},
    };
    // LLM that never resolves on its own — we cancel it.
    const llm = {
      complete: async function* (_req: any, opts?: { signal?: AbortSignal }) {
        await new Promise<void>((resolve, reject) => {
          if (opts?.signal?.aborted) return reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          opts?.signal?.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        });
        yield { type: "done", response: { content: "", finishReason: "stop" } } as const;
      },
      async listModels() { return []; },
    };
    const sessions = makeSessions();
    const ctx: any = {
      log: () => {},
      config: { defaultSystemPrompt: "sp" },
      defineService: () => {},
      provideService: () => {},
      consumeService: () => {},
      defineEvent: () => {},
      useService: (n: string) => {
        if (n === "ui:channel") return ui;
        if (n === "llm:complete") return llm;
        if (n === "sessions:store") return sessions;
        return undefined;
      },
      on: (n: string, fn: Function) => { (handlers[n] ??= []).push(fn); return () => {}; },
      emit: async (n: string, p?: any) => { events.push({ name: n, payload: p }); for (const fn of handlers[n] ?? []) await fn(p); },
    };

    await plugin.setup!(ctx);
    // Fire turn:cancel shortly after start to abort the pending LLM call.
    setTimeout(() => { ctx.emit("turn:cancel", {}); }, 10);
    await plugin.start!(ctx);

    // Find the active session id from emitted events.
    const created = events.find((e) => e.name === "session:active-changed");
    const sessionId = created?.payload?.to;
    expect(sessionId).toBeTruthy();
    const snapshot = await sessions.getMessages(sessionId);
    expect(snapshot).toEqual([{ role: "user", content: "amend my request later" }]);

    const turnEnd = events.find((e) => e.name === "turn:end");
    expect(turnEnd?.payload?.reason).toBe("cancelled");
  });
});
