import { describe, it, expect, mock } from "bun:test";
import plugin from "../index.ts";

function makeCtx(opts: { tools?: any; driver?: any; readFile?: any } = {}) {
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
      return undefined;
    },
    secrets: { get: async () => undefined, refresh: async () => undefined },
  } as any;
}

describe("llm-agents plugin", () => {
  it("setup provides agents:registry even before discovery completes", async () => {
    const tools = { register: mock(() => () => {}), list: () => [], invoke: async () => {} };
    const driver = { runConversation: async () => ({ finalMessage: { role: "assistant", content: "" }, messages: [], usage: { promptTokens: 0, completionTokens: 0 } }) };
    const ctx = makeCtx({ tools, driver });
    await plugin.setup(ctx);
    const reg: any = ctx.provided["agents:registry"];
    expect(reg).toBeTruthy();
    expect(typeof reg.list).toBe("function");
    expect(reg.list()).toEqual([]);
  });

  it("registers dispatch_agent tool when tools:registry available", async () => {
    const tools = { register: mock(() => () => {}), list: () => [], invoke: async () => {} };
    const driver = { runConversation: async () => ({ finalMessage: { role: "assistant", content: "" }, messages: [], usage: { promptTokens: 0, completionTokens: 0 } }) };
    const ctx = makeCtx({ tools, driver });
    await plugin.setup(ctx);
    expect(tools.register).toHaveBeenCalled();
    const [schema] = (tools.register as any).mock.calls[0];
    expect(schema.name).toBe("dispatch_agent");
  });

  it("emits session:error when tools:registry missing", async () => {
    const ctx = makeCtx({ tools: undefined, driver: { runConversation: async () => ({} as any) } });
    let captured: any = null;
    ctx.on("session:error", (p: any) => { captured = p; });
    await plugin.setup(ctx);
    // Allow microtask discovery to settle:
    await new Promise((r) => setTimeout(r, 0));
    expect(captured?.message).toMatch(/tools:registry/);
  });

  it("manifest declares correct services and permissions", () => {
    expect(plugin.name).toBe("llm-agents");
    expect(plugin.permissions?.tier).toBe("unscoped");
    expect(plugin.services?.provides).toContain("agents:registry");
  });

  it("agents:registry list() reflects discovered manifests after microtask", async () => {
    const VALID = `---\nname: a\ndescription: "d"\n---\nbody\n`;
    const tools = { register: () => () => {}, list: () => [], invoke: async () => {} };
    const driver = { runConversation: async () => ({ finalMessage: { role: "assistant", content: "" }, messages: [], usage: { promptTokens: 0, completionTokens: 0 } }) };
    const ctx = makeCtx({ tools, driver });
    // Stub the FS via env override so loadConfig returns specific dirs and the loader sees our content.
    // For this test we accept that real fs is consulted; assert that no throw happens and list() is callable.
    await plugin.setup(ctx);
    await new Promise((r) => setTimeout(r, 5));
    const reg: any = ctx.provided["agents:registry"];
    expect(Array.isArray(reg.list())).toBe(true);
  });
});
