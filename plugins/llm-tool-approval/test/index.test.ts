import { describe, it, expect, mock } from "bun:test";
import plugin from "../index.ts";
import type { ToolBeforeExecutePayload, UiPromptService, UiToolRendererService, UiChannelService, ConfigStoreService, ConfigSpec } from "llm-contracts/public";

function makeFakeCtx(opts: { hasPrompt?: boolean; hasRenderer?: boolean; hasChannel?: boolean; hasSlash?: boolean; hasConfig?: boolean } = {}) {
  const services = new Map<string, any>();
  const handlers: Record<string, ((p: any) => any)[]> = {};
  const emitted: { event: string; payload: any }[] = [];
  const statusEvents: any[] = [];
  const logs: string[] = [];
  const slashRegistered: any[] = [];

  if (opts.hasConfig !== false) {
    let registered: ConfigSpec<any> | null = null;
    const store: ConfigStoreService = {
      register: (spec) => { registered = spec as ConfigSpec<any>; },
      get: (<T,>(_plugin: string): T => {
        const d = (registered?.defaults ?? { allow: [], deny: [] }) as any;
        return { allow: [...(d.allow ?? [])], deny: [...(d.deny ?? [])] } as unknown as T;
      }) as ConfigStoreService["get"],
      set: async () => {},
      watch: () => () => {},
      list: () => [{
        plugin: "llm-tool-approval",
        homePath: "/home/u/.kaizen/harnesses/local/config.json",
        projectPath: "/proj/.kaizen/harnesses/local/config.json",
        homeExists: false,
        projectExists: false,
        resolution: { allow: "default", deny: "default" },
      }],
    };
    services.set("config:store", store);
  }

  if (opts.hasPrompt !== false) {
    const prompt: UiPromptService = {
      requestOption: mock(async (req: any) => ({ id: "approve-once" })),
      requestText: async () => "",
    };
    services.set("ui:prompt", prompt);
  }
  if (opts.hasRenderer !== false) {
    services.set("ui:tool-renderer", {
      register: () => () => {},
      summarize: (name: string, args: unknown) => `${name} ${JSON.stringify(args)}`,
    } satisfies UiToolRendererService);
  }
  if (opts.hasChannel !== false) {
    services.set("ui:channel", {
      writeOutput: () => {}, writeNotice: () => {}, writeUser: () => {},
      setBusy: () => {}, setBusyTiming: () => {}, updateBusyTokens: () => {}, incrementBusyTokens: () => {},
      readInput: async () => "", appendReasoning: () => {}, finalizeReasoning: () => {}, clearLiveThinking: () => {}, setInputDraft: () => {},
    } satisfies UiChannelService);
  }
  if (opts.hasSlash !== false) {
    services.set("slash:registry", {
      register(manifest: any, handler: any) {
        slashRegistered.push({ manifest, handler });
        return () => {};
      },
    });
  }

  const ctx: any = {
    consumeService: () => {},
    useService: (id: string) => {
      if (!services.has(id)) throw new Error(`no provider: ${id}`);
      return services.get(id);
    },
    on: (event: string, fn: (p: any) => any) => { (handlers[event] ??= []).push(fn); },
    emit: async (event: string, payload: any) => {
      emitted.push({ event, payload });
      for (const fn of handlers[event] ?? []) await fn(payload);
    },
    log: (msg: string) => { logs.push(msg); },
    config: {},
  };

  return { ctx, services, handlers, emitted, logs, slashRegistered, statusEvents };
}

describe("llm-tool-approval plugin", () => {
  it("has plugin metadata", () => {
    expect(plugin.name).toBe("llm-tool-approval");
    expect(plugin.services?.consumes).toEqual(expect.arrayContaining([
      "ui:prompt", "ui:tool-renderer", "ui:channel", "ui:status", "slash:registry", "config:store",
    ]));
  });

  it("registers its config spec on setup", async () => {
    const { ctx, services } = makeFakeCtx();
    const store = services.get("config:store") as ConfigStoreService;
    const registerSpy = mock(store.register);
    (store as any).register = registerSpy;
    await plugin.setup(ctx);
    expect(registerSpy).toHaveBeenCalled();
    const spec = (registerSpy.mock.calls[0] as any[])[0];
    expect(spec.plugin).toBe("llm-tool-approval");
    expect(Array.isArray(spec.defaults.allow)).toBe(true);
    expect(Array.isArray(spec.defaults.deny)).toBe(true);
  });

  it("subscribes to tool:before-execute and prompts when no rule matches", async () => {
    const { ctx, services, handlers } = makeFakeCtx();
    await plugin.setup(ctx);
    await ctx.emit("harness:start", {});
    const sub = handlers["tool:before-execute"]?.[0];
    expect(sub).toBeDefined();
    // pick a name that does NOT match any shipped default (defaults include execute_typescript, llm-skills:*, etc.)
    const payload: ToolBeforeExecutePayload = { name: "mcp:github:list_issues", args: { state: "open" }, callId: "c1" };
    await sub(payload);
    const prompt = services.get("ui:prompt") as any;
    expect(prompt.requestOption).toHaveBeenCalled();
  });

  it("emits a status:item-update for the approval status item", async () => {
    const { ctx, emitted } = makeFakeCtx();
    await plugin.setup(ctx);
    await ctx.emit("harness:start", {});
    const statusUpdate = emitted.find((e) => e.event === "status:item-update" && e.payload?.key === "approval");
    expect(statusUpdate).toBeDefined();
    expect(statusUpdate!.payload.value).toMatch(/^(request|paused)$/);
  });

  it("registers three slash commands", async () => {
    const { ctx, slashRegistered } = makeFakeCtx();
    await plugin.setup(ctx);
    await ctx.emit("harness:start", {});
    const names = slashRegistered.map((r: any) => r.manifest.name).sort();
    expect(names).toEqual(["approval:pause", "approval:resume", "approval:status"]);
  });

  it("auto-denies every call when ui:prompt is missing", async () => {
    const { ctx, handlers, logs } = makeFakeCtx({ hasPrompt: false });
    await plugin.setup(ctx);
    await ctx.emit("harness:start", {});
    const sub = handlers["tool:before-execute"]?.[0]!;
    const payload: ToolBeforeExecutePayload = { name: "fs:read_file", args: {}, callId: "c1" };
    await sub(payload);
    expect(payload.args).toBe(Symbol.for("kaizen.cancel"));
    expect(payload.cancelReason).toContain("approval gate misconfigured");
    expect(logs.some((l) => l.includes("ui:prompt"))).toBe(true);
  });
});
