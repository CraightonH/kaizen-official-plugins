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

function makeFakeCtx() {
  const services: Record<string, unknown> = {};
  const provided: Record<string, unknown> = {};
  const consumed: string[] = [];
  const events: string[] = [];
  const emitted: Array<{ name: string; payload: unknown }> = [];
  const slashRegistrations: Array<{ name: string; description: string }> = [];

  const slashRegistry = {
    register(manifest: { name: string; description: string }, _h: unknown) {
      slashRegistrations.push(manifest);
      return () => {};
    },
    get: () => undefined,
    list: () => [],
  };

  return {
    cwd: tmpdir(),
    env: {} as Record<string, string | undefined>,
    log: (_m: string) => {},
    defineService: (n: string, _o: unknown) => { services[n] = _o; },
    provideService: <T,>(n: string, v: T) => { provided[n] = v; },
    consumeService: (n: string) => { consumed.push(n); },
    useService: (n: string) => {
      if (n === "slash:registry") return slashRegistry;
      return undefined;
    },
    defineEvent: (n: string) => { events.push(n); },
    emit: async (n: string, p: unknown) => { emitted.push({ name: n, payload: p }); },
    on: (_n: string, _h: unknown) => {},
    config: {},
    services, provided, consumed, events, emitted, slashRegistrations, slashRegistry,
  };
}

describe("llm-system-prompt plugin manifest", () => {
  it("exports a KaizenPlugin with the correct name and apiVersion", () => {
    expect(plugin.name).toBe("llm-system-prompt");
    expect(plugin.apiVersion).toBe("3.0.0");
    expect(plugin.permissions?.tier).toBe("trusted");
  });

  it("provides prompt:system", () => {
    expect(plugin.services?.provides).toContain("prompt:system");
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
  it("setup defines and provides prompt:system", async () => {
    const ctx = makeFakeCtx();
    await plugin.setup!(ctx as any);
    expect(ctx.consumed).toContain("slash:registry");
    expect("prompt:system" in ctx.services).toBe(true);
    expect("prompt:system" in ctx.provided).toBe(true);
  });

  it("setup defines prompt:rebuilt and prompt:reload events", async () => {
    const ctx = makeFakeCtx();
    await plugin.setup!(ctx as any);
    expect(ctx.events).toContain("prompt:rebuilt");
    expect(ctx.events).toContain("prompt:reload");
  });

  it("setup registers identity section at priority 10", async () => {
    const ctx = makeFakeCtx();
    await plugin.setup!(ctx as any);
    const svc = ctx.provided["prompt:system"] as any;
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

  it("setup with global file present picks it up", async () => {
    const dir = join(tmpdir(), `kaizen-sysprompt-test-${Date.now()}`);
    mkdirSync(join(dir, "global"), { recursive: true });
    writeFileSync(join(dir, "global", "system-prompt.md"), "GLOBAL-MARKER");

    const ctx = makeFakeCtx();
    ctx.env.KAIZEN_SYSTEM_PROMPT_GLOBAL = join(dir, "global", "system-prompt.md");
    await plugin.setup!(ctx as any);
    const svc = ctx.provided["prompt:system"] as any;
    const out = await svc.assemble();
    expect(out).toContain("GLOBAL-MARKER");
    rmSync(dir, { recursive: true, force: true });
  });
});
