// plugins/llm-driver/test/integration.test.ts
import { describe, it, expect, mock } from "bun:test";
import plugin from "../index.ts";

describe("llm-driver integration (synthetic llm:complete)", () => {
  it("session-level event sequence is exactly correct for a single turn", async () => {
    const handlers: Record<string, Function[]> = {};
    const events: { name: string; payload: any }[] = [];
    const ui = {
      i: 0,
      readInput: async function () { return this.i++ === 0 ? "hello" : ""; },
      setBusy: () => {},
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
    const ctx: any = {
      log: () => {},
      config: { defaultModel: "m", defaultSystemPrompt: "sp" },
      defineService: () => {},
      provideService: () => {},
      consumeService: () => {},
      defineEvent: () => {},
      useService: (n: string) => {
        if (n === "llm-tui:channel") return ui;
        if (n === "llm:complete") return llm;
        throw new Error(`useService: no provider for '${n}'`);
      },
      on: (n: string, fn: Function) => { (handlers[n] ??= []).push(fn); return () => {}; },
      emit: async (n: string, p?: any) => { events.push({ name: n, payload: p }); for (const fn of handlers[n] ?? []) await fn(p); },
    };
    await plugin.setup!(ctx);
    await plugin.start!(ctx);
    const seq = events.map(e => e.name);
    // Required ordering checkpoints (other events may interleave but these MUST appear in order):
    expect(seq[0]).toBe("session:start");
    expect(seq.indexOf("turn:start")).toBeGreaterThan(0);
    expect(seq.indexOf("llm:before-call")).toBeGreaterThan(seq.indexOf("turn:start"));
    expect(seq.indexOf("llm:request")).toBeGreaterThan(seq.indexOf("llm:before-call"));
    expect(seq.indexOf("llm:done")).toBeGreaterThan(seq.indexOf("llm:request"));
    expect(seq.indexOf("conversation:assistant-message")).toBeGreaterThan(seq.indexOf("llm:done"));
    expect(seq.indexOf("turn:end")).toBeGreaterThan(seq.indexOf("conversation:assistant-message"));
    expect(seq.at(-1)).toBe("session:end");
  });
});
