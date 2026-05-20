import { describe, it, expect, mock } from "bun:test";
import plugin from "../index.ts";
import { CANCEL_TOOL, CODEMODE_CANCEL_SENTINEL } from "llm-events";
import type { ConfigStoreService, ConfigSpec } from "llm-contracts/public";
import type { HooksConfig } from "../public";

interface Emit { event: string; payload: any }

function makeCtx(opts: {
  hooks?: any[];                            // resolved entries returned by config:store
  vocab?: string[];                         // valid event names
  exec?: (bin: string, args: string[], opts: any) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
}) {
  const subscribed: string[] = [];
  const handlers: Record<string, (p: any) => Promise<void> | void> = {};
  const emits: Emit[] = [];
  const logs: { level: "info" | "warn"; msg: string }[] = [];
  const vocab = new Set(opts.vocab ?? [
    "turn:start", "turn:end", "tool:before-execute", "codemode:before-execute",
    "llm:before-call", "llm:done", "tool:result", "conversation:cleared",
  ]);

  let registered: ConfigSpec<HooksConfig> | null = null;
  const store: ConfigStoreService = {
    register: (spec) => { registered = spec as ConfigSpec<HooksConfig>; },
    get: (<T,>(_plugin: string): T => {
      // If the test supplied hooks, return them. Otherwise fall back to defaults.
      const hooks = opts.hooks ?? (registered?.defaults as HooksConfig | undefined)?.hooks ?? [];
      return { hooks } as unknown as T;
    }) as ConfigStoreService["get"],
    set: async () => {},
    watch: () => () => {},
    list: () => [{
      plugin: "llm-hooks-shell",
      homePath: "/home/u/.kaizen/harnesses/local/config.json",
      projectPath: "/proj/.kaizen/harnesses/local/config.json",
      homeExists: false,
      projectExists: false,
      resolution: { hooks: "default" },
    }],
  };

  return {
    subscribed,
    handlers,
    emits,
    logs,
    log: (m: string) => logs.push({ level: "info", msg: m }),
    config: {},
    defineEvent: mock(() => {}),
    on: mock((name: string, fn: (p: any) => any) => { subscribed.push(name); handlers[name] = fn; }),
    emit: mock(async (event: string, payload: any) => { emits.push({ event, payload }); return []; }),
    defineService: mock(() => {}),
    provideService: mock(() => {}),
    consumeService: mock(() => {}),
    useService: mock((name: string) => {
      if (name === "events:vocabulary") {
        const obj: Record<string, string> = {};
        for (const v of vocab) obj[v.toUpperCase().replace(/[:\-]/g, "_")] = v;
        return Object.freeze(obj);
      }
      if (name === "config:store") return store;
      return undefined;
    }),
    secrets: { get: mock(async () => undefined), refresh: mock(async () => undefined) },
    exec: { run: opts.exec ?? (async () => ({ exitCode: 0, stdout: "", stderr: "" })) },
  } as any;
}

describe("llm-hooks-shell setup", () => {
  it("no config files → no subscriptions and no startup log noise", async () => {
    const ctx = makeCtx({});
    await plugin.setup(ctx);
    expect(ctx.subscribed).toEqual([]);
    expect(ctx.logs).toEqual([]);
  });

  it("subscribes to the union of event names from the resolved config", async () => {
    const ctx = makeCtx({
      hooks: [
        { event: "turn:start", command: "echo a" },
        { event: "turn:end", command: "echo b" },
      ],
    });
    await plugin.setup(ctx);
    expect(ctx.subscribed.sort()).toEqual(["turn:end", "turn:start"]);
  });

  it("rejects unknown event in config (refuses to start)", async () => {
    const ctx = makeCtx({ hooks: [{ event: "totally:bogus", command: "echo a" }] });
    await expect(plugin.setup(ctx)).rejects.toThrow(/totally:bogus/);
  });

  it("successful hook (exit 0) does not block tool:before-execute", async () => {
    const ctx = makeCtx({
      hooks: [{ event: "tool:before-execute", command: "true", block_on_nonzero: true }],
      exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    });
    await plugin.setup(ctx);
    const payload: any = { name: "bash", args: { cmd: "ls" }, callId: "c1" };
    await ctx.handlers["tool:before-execute"]!(payload);
    expect(payload.args).toEqual({ cmd: "ls" });
  });

  it("failing hook (exit 1) without block_on_nonzero does NOT cancel tool:before-execute", async () => {
    const ctx = makeCtx({
      hooks: [{ event: "tool:before-execute", command: "false" }],
      exec: async () => ({ exitCode: 1, stdout: "", stderr: "denied" }),
    });
    await plugin.setup(ctx);
    const payload: any = { name: "bash", args: { cmd: "ls" }, callId: "c1" };
    await ctx.handlers["tool:before-execute"]!(payload);
    expect(payload.args).toEqual({ cmd: "ls" });
  });

  it("failing hook with block_on_nonzero: true on tool:before-execute cancels via CANCEL_TOOL and emits tool:error", async () => {
    const ctx = makeCtx({
      hooks: [{ event: "tool:before-execute", command: "false", block_on_nonzero: true }],
      exec: async () => ({ exitCode: 1, stdout: "", stderr: "denied by gate\n" }),
    });
    await plugin.setup(ctx);
    const payload: any = { name: "bash", args: { cmd: "rm -rf /" }, callId: "c1" };
    await ctx.handlers["tool:before-execute"]!(payload);
    expect(payload.args).toBe(CANCEL_TOOL);
    const errEmit = ctx.emits.find((e: Emit) => e.event === "tool:error");
    expect(errEmit?.payload.callId).toBe("c1");
    expect(errEmit?.payload.message).toContain("denied by gate");
  });

  it("blocking on codemode:before-execute mutates payload.code to CODEMODE_CANCEL_SENTINEL", async () => {
    const ctx = makeCtx({
      hooks: [{ event: "codemode:before-execute", command: "false", block_on_nonzero: true }],
      exec: async () => ({ exitCode: 1, stdout: "", stderr: "no" }),
    });
    await plugin.setup(ctx);
    const payload: any = { code: "console.log('hi')" };
    await ctx.handlers["codemode:before-execute"]!(payload);
    expect(payload.code).toBe(CODEMODE_CANCEL_SENTINEL);
  });

  it("blocking on llm:before-call sets payload.request.cancelled = true", async () => {
    const ctx = makeCtx({
      hooks: [{ event: "llm:before-call", command: "false", block_on_nonzero: true }],
      exec: async () => ({ exitCode: 1, stdout: "", stderr: "stop" }),
    });
    await plugin.setup(ctx);
    const payload: any = { request: { model: "x", messages: [] } };
    await ctx.handlers["llm:before-call"]!(payload);
    expect(payload.request.cancelled).toBe(true);
  });

  it("multiple hooks on same event run in config order", async () => {
    const calls: string[] = [];
    const ctx = makeCtx({
      hooks: [
        { event: "turn:start", command: "echo first" },
        { event: "turn:start", command: "echo second" },
      ],
      exec: async (_b, args) => { calls.push(args[1]!); return { exitCode: 0, stdout: "", stderr: "" }; },
    });
    await plugin.setup(ctx);
    await ctx.handlers["turn:start"]!({ turnId: "t-1" });
    expect(calls).toEqual(["echo first", "echo second"]);
  });

  it("blocking failure on hook #1 short-circuits hook #2", async () => {
    const calls: string[] = [];
    const ctx = makeCtx({
      hooks: [
        { event: "tool:before-execute", command: "deny", block_on_nonzero: true },
        { event: "tool:before-execute", command: "log" },
      ],
      exec: async (_b, args) => {
        calls.push(args[1]!);
        if (args[1] === "deny") return { exitCode: 1, stdout: "", stderr: "no" };
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    await plugin.setup(ctx);
    await ctx.handlers["tool:before-execute"]!({ name: "bash", args: {}, callId: "c1" });
    expect(calls).toEqual(["deny"]);
  });

  it("non-blocking failure does NOT short-circuit subsequent hooks", async () => {
    const calls: string[] = [];
    const ctx = makeCtx({
      hooks: [
        { event: "turn:start", command: "fail" },
        { event: "turn:start", command: "audit" },
      ],
      exec: async (_b, args) => {
        calls.push(args[1]!);
        if (args[1] === "fail") return { exitCode: 1, stdout: "", stderr: "x" };
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    await plugin.setup(ctx);
    await ctx.handlers["turn:start"]!({ turnId: "t-1" });
    expect(calls).toEqual(["fail", "audit"]);
  });

  it("block_on_nonzero on a non-mutable event logs a setup warning and is ignored at runtime", async () => {
    const calls: string[] = [];
    const ctx = makeCtx({
      hooks: [{ event: "turn:end", command: "boom", block_on_nonzero: true }],
      exec: async (_b, args) => {
        calls.push(args[1]!);
        return { exitCode: 1, stdout: "", stderr: "" };
      },
    });
    await plugin.setup(ctx);
    expect(ctx.logs.some((l: { msg: string }) => /block_on_nonzero.*turn:end/.test(l.msg))).toBe(true);
    // Hook still runs:
    await ctx.handlers["turn:end"]!({ turnId: "t-1", reason: "complete" });
    expect(calls).toEqual(["boom"]);
  });

  it("env vars include EVENT_NAME and the flattened payload", async () => {
    let captured: any = null;
    const ctx = makeCtx({
      hooks: [{ event: "turn:start", command: "echo", env: { EXTRA: "yes" } }],
      exec: async (_b, _a, opts) => { captured = opts.env; return { exitCode: 0, stdout: "", stderr: "" }; },
    });
    await plugin.setup(ctx);
    await ctx.handlers["turn:start"]!({ turnId: "t-7", trigger: "user" });
    expect(captured.EVENT_NAME).toBe("turn:start");
    expect(captured.EVENT_TURN_ID).toBe("t-7");
    expect(captured.EVENT_TRIGGER).toBe("user");
    expect(captured.EXTRA).toBe("yes");
  });

  it("registers its config spec on setup", async () => {
    const ctx = makeCtx({});
    const store = ctx.useService("config:store");
    const registerSpy = mock(store.register);
    (store as any).register = registerSpy;
    await plugin.setup(ctx);
    expect(registerSpy).toHaveBeenCalled();
    const spec = (registerSpy.mock.calls[0] as any[])[0];
    expect(spec.plugin).toBe("llm-hooks-shell");
    expect(Array.isArray(spec.defaults.hooks)).toBe(true);
    expect(spec.defaults.hooks).toEqual([]);
  });
});
