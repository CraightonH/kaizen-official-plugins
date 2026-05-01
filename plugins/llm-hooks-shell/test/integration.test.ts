import { describe, it, expect, mock } from "bun:test";
import plugin from "../index.ts";
import { CANCEL_TOOL } from "llm-events";

function makeBusCtx(opts: { hooks: any[]; exec: (bin: string, args: string[], opts: any) => Promise<{ exitCode: number; stdout: string; stderr: string }> }) {
  const subs: Record<string, ((p: any) => Promise<void> | void)[]> = {};
  const allEmits: { event: string; payload: any }[] = [];
  const ctx: any = {
    log: () => {},
    config: {},
    defineEvent: () => {},
    on: (name: string, fn: any) => { (subs[name] ??= []).push(fn); },
    emit: async (event: string, payload: any) => {
      allEmits.push({ event, payload });
      const handlers = subs[event] ?? [];
      for (const h of handlers) await h(payload);
      return [];
    },
    defineService: () => {},
    provideService: () => {},
    consumeService: () => {},
    useService: (name: string) => {
      if (name === "llm-events:vocabulary") {
        return Object.freeze({ TOOL_BEFORE_EXECUTE: "tool:before-execute", TOOL_ERROR: "tool:error", TOOL_RESULT: "tool:result" });
      }
      return undefined;
    },
    secrets: { get: mock(async () => undefined), refresh: mock(async () => undefined) },
    exec: { run: opts.exec },
    _testHookDeps: {
      home: "/home/u",
      cwd: "/work/proj",
      readFile: async (p: string) => p.startsWith("/home/u/")
        ? JSON.stringify({ hooks: opts.hooks })
        : (() => { const e: any = new Error("ENOENT"); e.code = "ENOENT"; throw e; })(),
    },
  };
  return { ctx, allEmits };
}

describe("llm-hooks-shell integration", () => {
  it("blocking hook on tool:before-execute prevents tool:execute and surfaces tool:error", async () => {
    const executedTools: any[] = [];
    const { ctx, allEmits } = makeBusCtx({
      hooks: [{ event: "tool:before-execute", command: "false", block_on_nonzero: true }],
      exec: async () => ({ exitCode: 1, stdout: "", stderr: "blocked\n" }),
    });

    // Fake tool registry: subscribe to tool:before-execute AFTER the hooks plugin
    // (deterministic delivery order: registration order). Skip if args === CANCEL_TOOL.
    await plugin.setup(ctx);
    ctx.on("tool:before-execute", async (payload: any) => {
      if (payload.args === CANCEL_TOOL) return; // cancelled
      executedTools.push({ name: payload.name, args: payload.args });
      await ctx.emit("tool:result", { callId: payload.callId, result: "ok" });
    });

    await ctx.emit("tool:before-execute", { name: "bash", args: { cmd: "rm -rf /" }, callId: "c1" });

    expect(executedTools).toEqual([]);
    const errs = allEmits.filter((e) => e.event === "tool:error");
    expect(errs).toHaveLength(1);
    expect(errs[0]!.payload.callId).toBe("c1");
    expect(errs[0]!.payload.message).toContain("blocked");
  });

  it("audit hook on turn:start receives the turn id in the env", async () => {
    let captured: Record<string, string> | null = null;
    const { ctx } = makeBusCtx({
      hooks: [{ event: "turn:start", command: "echo $EVENT_TURN_ID" }],
      exec: async (_b, _a, opts) => { captured = opts.env; return { exitCode: 0, stdout: "t-42\n", stderr: "" }; },
    });
    // Add turn:start to the vocab so config validation passes.
    ctx.useService = (name: string) => {
      if (name === "llm-events:vocabulary") return Object.freeze({ TURN_START: "turn:start" });
      return undefined;
    };
    await plugin.setup(ctx);
    await ctx.emit("turn:start", { turnId: "t-42", trigger: "user" });
    expect(captured?.EVENT_TURN_ID).toBe("t-42");
  });
});
