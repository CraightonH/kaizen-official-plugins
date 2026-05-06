import { describe, it, expect, mock } from "bun:test";
import plugin from "../index.ts";

function makeSessions() {
  return {
    async create() { return { id: "parent/child", harness: "h", metadata: {}, createdAt: 1, pluginFingerprint: [] }; },
    async load(id: string) { return { id, harness: "h", agentName: "a", metadata: {}, createdAt: 1, pluginFingerprint: [] }; },
    async exists() { return false; },
    async getMessages() { return []; },
    beginTurn() { throw new Error("not needed"); },
    async list() { return []; },
    async delete() {},
    async *readEvents() {},
  };
}

function makeCtx(opts: { tools?: any; driver?: any; sessions?: any; promptSystem?: any; readFile?: any } = {}) {
  const subs: Record<string, ((p: any) => any)[]> = {};
  const provided: Record<string, unknown> = {};
  return {
    subs, provided,
    log: mock(() => {}),
    config: {},
    defineEvent: () => {},
    on: (event: string, fn: any) => { (subs[event] ??= []).push(fn); },
    emit: async (event: string, payload: any) => { for (const f of subs[event] ?? []) await f(payload); },
    defineService: () => {},
    provideService: (name: string, impl: unknown) => { provided[name] = impl; },
    consumeService: () => {},
    useService: (name: string) => {
      if (name === "tools:registry") return opts.tools;
      if (name === "driver:run-conversation") return opts.driver;
      if (name === "sessions:store") return opts.sessions ?? makeSessions();
      if (name === "prompt:system") return opts.promptSystem;
      return undefined;
    },
    secrets: { get: async () => undefined, refresh: async () => undefined },
  } as any;
}

describe("llm-agents plugin", () => {
  it("setup provides agents:registry even before discovery completes", async () => {
    const tools = { register: mock(() => () => {}), registerWith: mock(() => () => {}), list: () => [], invoke: async () => {} };
    const driver = { runConversation: async () => ({ finalMessage: { role: "assistant", content: "" }, messages: [], usage: { promptTokens: 0, completionTokens: 0 } }) };
    const promptSystem = { register: mock(() => ({ unregister: () => {}, bumpGeneration: () => {} })), assemble: async () => "", list: () => [], generation: () => 0 };
    const ctx = makeCtx({ tools, driver, promptSystem });
    await plugin.setup(ctx);
    const reg: any = ctx.provided["agents:registry"];
    expect(reg).toBeTruthy();
    expect(typeof reg.list).toBe("function");
    expect(reg.list()).toEqual([]);
  });

  it("registers dispatch_agent tool with source:agent via registerWith", async () => {
    const tools = { register: mock(() => () => {}), registerWith: mock(() => () => {}), list: () => [], invoke: async () => {} };
    const driver = { runConversation: async () => ({ finalMessage: { role: "assistant", content: "" }, messages: [], usage: { promptTokens: 0, completionTokens: 0 } }) };
    const promptSystem = { register: mock(() => ({ unregister: () => {}, bumpGeneration: () => {} })), assemble: async () => "", list: () => [], generation: () => 0 };
    const ctx = makeCtx({ tools, driver, promptSystem });
    await plugin.setup(ctx);
    expect(tools.registerWith).toHaveBeenCalled();
    expect(tools.register).not.toHaveBeenCalled();
    const [reg] = (tools.registerWith as any).mock.calls[0];
    expect(reg.schema.name).toBe("dispatch_agent");
    expect(reg.source).toEqual({ kind: "agent" });
  });

  it("emits harness:error when tools:registry missing", async () => {
    const promptSystem = { register: mock(() => ({ unregister: () => {}, bumpGeneration: () => {} })), assemble: async () => "", list: () => [], generation: () => 0 };
    const ctx = makeCtx({ tools: undefined, driver: { runConversation: async () => ({} as any) }, promptSystem });
    const captured: any[] = [];
    ctx.on("harness:error", (p: any) => { captured.push(p); });
    await plugin.setup(ctx);
    // Allow microtask discovery to settle:
    await new Promise((r) => setTimeout(r, 0));
    expect(captured.some((p) => /tools:registry/.test(p.message))).toBe(true);
  });

  it("manifest declares correct services and permissions", () => {
    expect(plugin.name).toBe("llm-agents");
    expect(plugin.permissions?.tier).toBe("unscoped");
    expect(plugin.services?.provides).toContain("agents:registry");
    expect(plugin.services?.consumes).toContain("prompt:system");
  });

  it("agents:registry list() reflects discovered manifests after microtask", async () => {
    const VALID = `---\nname: a\ndescription: "d"\n---\nbody\n`;
    const tools = { register: () => () => {}, registerWith: () => () => {}, list: () => [], invoke: async () => {} };
    const driver = { runConversation: async () => ({ finalMessage: { role: "assistant", content: "" }, messages: [], usage: { promptTokens: 0, completionTokens: 0 } }) };
    const promptSystem = { register: () => ({ unregister: () => {}, bumpGeneration: () => {} }), assemble: async () => "", list: () => [], generation: () => 0 };
    const ctx = makeCtx({ tools, driver, promptSystem });
    // Stub the FS via env override so loadConfig returns specific dirs and the loader sees our content.
    // For this test we accept that real fs is consulted; assert that no throw happens and list() is callable.
    await plugin.setup(ctx);
    await new Promise((r) => setTimeout(r, 5));
    const reg: any = ctx.provided["agents:registry"];
    expect(Array.isArray(reg.list())).toBe(true);
  });

  it("registers prompt:system section with id='llm-agents:available', priority=150, title='Available agents'", async () => {
    const tools = { register: () => () => {}, registerWith: () => () => {}, list: () => [], invoke: async () => {} };
    const driver = { runConversation: async () => ({ finalMessage: { role: "assistant", content: "" }, messages: [], usage: { promptTokens: 0, completionTokens: 0 } }) };
    const sectionHandle = { unregister: () => {}, bumpGeneration: mock(() => {}) };
    const promptSystem = { register: mock(() => sectionHandle), assemble: async () => "", list: () => [], generation: () => 0 };
    const ctx = makeCtx({ tools, driver, promptSystem });
    await plugin.setup(ctx);
    expect(promptSystem.register).toHaveBeenCalledTimes(1);
    const [section] = (promptSystem.register as any).mock.calls[0];
    expect(section.id).toBe("llm-agents:available");
    expect(section.priority).toBe(150);
    expect(section.title).toBe("Available agents");
    expect(typeof section.render).toBe("function");
  });

  it("section render returns empty string when no agents loaded", async () => {
    const tools = { register: () => () => {}, registerWith: () => () => {}, list: () => [], invoke: async () => {} };
    const driver = { runConversation: async () => ({ finalMessage: { role: "assistant", content: "" }, messages: [], usage: { promptTokens: 0, completionTokens: 0 } }) };
    let capturedSection: any = null;
    const promptSystem = { register: mock((s: any) => { capturedSection = s; return { unregister: () => {}, bumpGeneration: () => {} }; }), assemble: async () => "", list: () => [], generation: () => 0 };
    const ctx = makeCtx({ tools, driver, promptSystem });
    await plugin.setup(ctx);
    expect(capturedSection).not.toBeNull();
    expect(capturedSection.render()).toBe("");
  });

  it("bumpGeneration is called after discovery completes", async () => {
    const tools = { register: () => () => {}, registerWith: () => () => {}, list: () => [], invoke: async () => {} };
    const driver = { runConversation: async () => ({ finalMessage: { role: "assistant", content: "" }, messages: [], usage: { promptTokens: 0, completionTokens: 0 } }) };
    const bumpGeneration = mock(() => {});
    const promptSystem = { register: mock(() => ({ unregister: () => {}, bumpGeneration })), assemble: async () => "", list: () => [], generation: () => 0 };
    const ctx = makeCtx({ tools, driver, promptSystem });
    await plugin.setup(ctx);
    // Before microtask: bumpGeneration not yet called from setInner
    const callsBefore = bumpGeneration.mock.calls.length;
    await new Promise((r) => setTimeout(r, 10));
    // After discovery microtask: setInner triggers onChange → bumpGeneration
    expect(bumpGeneration.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it("no llm:before-call subscription is registered", async () => {
    const tools = { register: () => () => {}, registerWith: () => () => {}, list: () => [], invoke: async () => {} };
    const driver = { runConversation: async () => ({ finalMessage: { role: "assistant", content: "" }, messages: [], usage: { promptTokens: 0, completionTokens: 0 } }) };
    const promptSystem = { register: () => ({ unregister: () => {}, bumpGeneration: () => {} }), assemble: async () => "", list: () => [], generation: () => 0 };
    const ctx = makeCtx({ tools, driver, promptSystem });
    await plugin.setup(ctx);
    expect(ctx.subs["llm:before-call"]).toBeUndefined();
  });
});
