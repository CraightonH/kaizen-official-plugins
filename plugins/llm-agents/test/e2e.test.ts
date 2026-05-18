import { describe, it, expect, mock } from "bun:test";
import { join } from "node:path";
import plugin from "../index.ts";

function makeConfigStore(initial: Record<string, unknown> = {}) {
  const stored: Record<string, unknown> = { ...initial };
  return {
    register: mock((spec: { plugin: string; defaults: unknown }) => {
      if (!(spec.plugin in stored)) stored[spec.plugin] = spec.defaults;
    }),
    get: mock(<T,>(plugin: string): T => (stored[plugin] ?? {}) as unknown as T),
    set: mock(async () => {}),
    watch: mock(() => () => {}),
    list: mock(() => Object.keys(stored).map((plugin) => ({ plugin }))),
  };
}

function makeCtx(opts: { tools?: any; driver?: any; configStore?: any } = {}) {
  const subs: Record<string, ((p: any) => any)[]> = {};
  const provided: Record<string, unknown> = {};
  let registeredTool: any = null;
  let registeredHandler: any = null;
  const sessions = {
    async create(opts: any) {
      return {
        id: `${opts.parentSessionId}/${opts.childId}`,
        harness: "h",
        parentSessionId: opts.parentSessionId,
        agentName: opts.agentName,
        metadata: {},
        createdAt: 1,
        pluginFingerprint: [],
      };
    },
    async load(id: string) { return { id, harness: "h", agentName: "code-reviewer", metadata: {}, createdAt: 1, pluginFingerprint: [] }; },
    async exists() { return false; },
    async getMessages() { return []; },
    beginTurn() { throw new Error("not needed"); },
    async list() { return []; },
    async delete() {},
    async *readEvents() {},
  };
  return {
    subs, provided,
    get registeredTool() { return registeredTool; },
    get registeredHandler() { return registeredHandler; },
    log: () => {},
    config: {},
    defineEvent: () => {},
    on: (event: string, fn: any) => { (subs[event] ??= []).push(fn); },
    emit: async (event: string, payload: any) => { for (const f of subs[event] ?? []) await f(payload); },
    defineService: () => {},
    provideService: (name: string, impl: unknown) => { provided[name] = impl; },
    consumeService: () => {},
    useService: (name: string) => {
      if (name === "tools:registry") return {
        register: (s: any, h: any) => { registeredTool = s; registeredHandler = h; return () => {}; },
        registerWith: (reg: any) => { registeredTool = reg.schema; registeredHandler = reg.handler; return () => {}; },
        list: () => [], invoke: async () => {},
      };
      if (name === "driver:run-conversation") return opts.driver;
      if (name === "sessions:store") return sessions;
      if (name === "prompt:registry") return {
        register: () => ({ unregister: () => {}, bumpGeneration: () => {} }),
        assemble: async () => "",
        list: () => [],
        generation: () => 0,
      };
      if (name === "config:store") return opts.configStore;
      return undefined;
    },
    secrets: { get: async () => undefined, refresh: async () => undefined },
  } as any;
}

describe("llm-agents E2E", () => {
  it("discovers fixtures, lists agents, dispatches with manifest system prompt", async () => {
    const fixturesRoot = new URL("./fixtures", import.meta.url).pathname;
    const configStore = makeConfigStore({
      "llm-agents": {
        maxDepth: 3,
        userDir: join(fixturesRoot, "agents-user"),
        projectDir: join(fixturesRoot, "agents-project"),
      },
    });

    let captured: any = null;
    const driver = {
      runConversation: mock(async (input: any) => {
        captured = input;
        return { finalMessage: { role: "assistant", content: "DONE" }, usage: { promptTokens: 1, completionTokens: 1 } };
      }),
    };
    const ctx = makeCtx({ driver, configStore });
    await plugin.setup(ctx);
    await new Promise((r) => setTimeout(r, 50));

    const reg: any = ctx.provided["agents:registry"];
    const names = reg.list().map((a: any) => a.name).sort();
    expect(names).toEqual(["code-reviewer", "doc-writer"]);

    // Simulate the parent turn so the tracker accepts the turnId.
    await ctx.emit("turn:start", { turnId: "t-parent", trigger: "user" });

    const handler = (ctx as any).registeredHandler;
    expect(handler).toBeTruthy();
    const result = await handler(
      { agent_name: "code-reviewer", prompt: "review file X" },
      { signal: new AbortController().signal, callId: "c1", turnId: "t-parent", sessionId: "parent-session", log: () => {} },
    );
    expect(result).toBe("DONE");
    expect(captured.systemPrompt).toContain("careful, terse code reviewer");
    expect(captured.parentTurnId).toBe("t-parent");
    expect(captured.sessionId).toMatch(/^parent-session\/oneshot-/);
    expect(captured.userMessage).toEqual({ role: "user", content: "review file X" });
    expect(captured.toolFilter.names).toContain("dispatch_agent");
    expect(captured.toolFilter.names).toContain("read_file");
  });
});
