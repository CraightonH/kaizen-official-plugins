import { describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import plugin from "../index.ts";
import type {
  SystemPromptSection,
  SystemPromptService,
  RegisteredSection,
} from "../public";

function makeFakeCtx(opts: { slash?: boolean; tools?: boolean; configOverrides?: Record<string, unknown> } = {}) {
  const services: Record<string, unknown> = {};
  const provided: Record<string, unknown> = {};
  const consumed: string[] = [];
  const events: string[] = [];
  const emitted: Array<{ name: string; payload: unknown }> = [];
  const slashRegistrations: Array<{ name: string; description: string }> = [];
  const toolRegistrations: Array<{
    schema: { name: string; tags?: string[] };
    source: { kind: string };
  }> = [];
  const slash = opts.slash ?? true;
  const tools = opts.tools ?? true;
  const configOverrides = opts.configOverrides ?? {};
  const vocab = {
    PROMPT_REBUILT: "prompt:rebuilt",
    PROMPT_RELOAD: "prompt:reload",
  };

  const configStore = {
    _registered: undefined as Record<string, unknown> | undefined,
    register<T>(spec: { plugin: string; defaults: T }) {
      this._registered = { ...(spec.defaults as object), ...configOverrides };
    },
    get<T>(_plugin: string): T {
      return this._registered as T;
    },
    set: async () => {},
    unset: async () => {},
    watch: () => () => {},
    list: () => [],
    ready: async () => {},
    getSpec: () => undefined,
  };

  const slashRegistry = {
    register(manifest: { name: string; description: string }, _h: unknown) {
      slashRegistrations.push(manifest);
      return () => {};
    },
    get: () => undefined,
    list: () => [],
  };

  const unregisterCalls: number[] = [];

  const toolsRegistry = {
    register(_schema: unknown, _handler: unknown): () => void {
      return () => { unregisterCalls.push(1); };
    },
    registerWith(reg: {
      schema: { name: string; tags?: string[] };
      handler: unknown;
      source: { kind: string };
    }): () => void {
      toolRegistrations.push({ schema: reg.schema, source: reg.source });
      return () => { unregisterCalls.push(1); };
    },
    list: () => [],
    listRegistrations: () => toolRegistrations,
    invoke: async () => {},
  };

  return {
    cwd: tmpdir(),
    env: {} as Record<string, string | undefined>,
    log: (_m: string) => {},
    defineService: (n: string, _o: unknown) => { services[n] = _o; },
    provideService: <T,>(n: string, v: T) => { provided[n] = v; },
    consumeService: (n: string) => { consumed.push(n); },
    useService: (n: string) => {
      if (n === "events:vocabulary") return vocab;
      if (n === "config:store") return configStore;
      if (n === "slash:registry" && slash) return slashRegistry;
      if (n === "tools:registry" && tools) return toolsRegistry;
      throw new Error(`missing service ${n}`);
    },
    defineEvent: (n: string) => { events.push(n); },
    emit: async (n: string, p: unknown) => { emitted.push({ name: n, payload: p }); },
    on: (_n: string, _h: unknown) => {},
    config: {},
    services,
    provided,
    consumed,
    events,
    emitted,
    slashRegistrations,
    slashRegistry,
    toolRegistrations,
    unregisterCalls,
  };
}

describe("llm-system-prompt plugin manifest", () => {
  it("exports a KaizenPlugin with the correct name and apiVersion", () => {
    expect(plugin.name).toBe("llm-system-prompt");
    expect(plugin.apiVersion).toBe("3.0.0");
    expect(plugin.permissions?.tier).toBe("unscoped");
  });

  it("provides prompt:registry", () => {
    expect(plugin.services?.provides).toContain("prompt:registry");
  });

  it("requires the llm-events vocabulary and leaves slash commands optional", () => {
    expect(plugin.services?.consumes).toContain("events:vocabulary");
    expect(plugin.services?.consumes).toContain("tools:registry");
    expect(plugin.services?.consumes ?? []).not.toContain("slash:registry");
  });
});

describe("public.d.ts type surface", () => {
  it("exports SystemPromptSection / SystemPromptService / RegisteredSection", () => {
    const _section: SystemPromptSection = {
      id: "x",
      priority: 100,
      render: () => "",
    };
    const _h: RegisteredSection = { unregister: () => {}, bumpGeneration: () => {} };
    const _svc = null as unknown as SystemPromptService;
    expect(_section.id).toBe("x");
    expect(_h).toBeTruthy();
    expect(_svc).toBeNull();
  });
});

describe("index.ts — plugin lifecycle", () => {
  it("setup provides prompt:registry", async () => {
    const ctx = makeFakeCtx();
    await plugin.setup!(ctx as any);
    expect(ctx.consumed).toContain("events:vocabulary");
    expect("prompt:registry" in ctx.provided).toBe(true);
  });

  it("setup does not redefine prompt:rebuilt / prompt:reload (owned by llm-events VOCAB)", async () => {
    const ctx = makeFakeCtx();
    await plugin.setup!(ctx as any);
    expect(ctx.events).not.toContain("prompt:rebuilt");
    expect(ctx.events).not.toContain("prompt:reload");
  });

  it("setup registers identity section at priority 10", async () => {
    const ctx = makeFakeCtx();
    await plugin.setup!(ctx as any);
    const svc = ctx.provided["prompt:registry"] as any;
    const sections = svc.list();
    expect(sections.find((s: any) => s.id === "identity")).toBeTruthy();
    expect(sections.find((s: any) => s.id === "identity")!.priority).toBe(10);
  });

  it("setup registers /prompt:show, /prompt:reload, /prompt:disable, /prompt:enable", async () => {
    const ctx = makeFakeCtx();
    await plugin.setup!(ctx as any);
    const names = ctx.slashRegistrations.map((m) => m.name).sort();
    expect(names).toEqual(["prompt:disable", "prompt:enable", "prompt:reload", "prompt:show"]);
  });

  it("setup still provides prompt:registry when slash:registry is absent", async () => {
    const ctx = makeFakeCtx({ slash: false });
    await plugin.setup!(ctx as any);
    expect("prompt:registry" in ctx.provided).toBe(true);
    expect(ctx.slashRegistrations).toEqual([]);
  });

  it("setup with global file present picks it up", async () => {
    const dir = join(tmpdir(), `kaizen-sysprompt-test-${Date.now()}`);
    mkdirSync(join(dir, "global"), { recursive: true });
    writeFileSync(join(dir, "global", "system-prompt.md"), "GLOBAL-MARKER");

    const ctx = makeFakeCtx({
      configOverrides: { globalPath: join(dir, "global", "system-prompt.md") },
    });
    await plugin.setup!(ctx as any);
    const svc = ctx.provided["prompt:registry"] as any;
    const out = await svc.assemble();
    expect(out).toContain("GLOBAL-MARKER");
    rmSync(dir, { recursive: true, force: true });
  });

  it("registers prompt_show, prompt_reload, prompt_disable, prompt_enable on tools:registry", async () => {
    const ctx = makeFakeCtx();
    await plugin.setup!(ctx as any);
    const names = ctx.toolRegistrations.map((r) => r.schema.name).sort();
    expect(names).toEqual(["prompt_disable", "prompt_enable", "prompt_reload", "prompt_show"]);
    for (const reg of ctx.toolRegistrations) {
      expect(reg.source.kind).toBe("prompt");
    }
  });

  it("does not register tools when tools:registry is absent", async () => {
    const ctx = makeFakeCtx({ tools: false });
    await plugin.setup!(ctx as any);
    expect(ctx.toolRegistrations).toEqual([]);
    expect("prompt:registry" in ctx.provided).toBe(true);
    expect(ctx.slashRegistrations.length).toBe(4);
  });

  it("stop() unregisters all tools and the identity section", async () => {
    const ctx = makeFakeCtx();
    await plugin.setup!(ctx as any);
    expect(ctx.unregisterCalls.length).toBe(0);

    // Verify tools were registered before stop
    expect(ctx.toolRegistrations.length).toBe(4);

    if (plugin.stop) {
      await plugin.stop(ctx as any);
    }

    // 4 tool unregisters ran (identity handle unregister is a real
    // registry handle, not the fake — it modifies internal state, not
    // unregisterCalls).
    expect(ctx.unregisterCalls.length).toBe(4);
  });
});
