import { describe, it, expect, mock } from "bun:test";
import { join } from "node:path";
import plugin from "../index.ts";

const FIXTURES = join(import.meta.dir, "fixtures");

interface FakeServices {
  skillsRegistry?: any;
  configStore?: any;
}

function makeCtx(opts: {
  cwd?: string;
  env?: Record<string, string | undefined>;
  services?: FakeServices;
} = {}) {
  const env = { ...process.env, HOME: "/tmp/does-not-exist", ...opts.env };
  const subscribers: Record<string, Function[]> = {};
  const services: Record<string, unknown> = {};
  if (opts.services?.skillsRegistry) services["skills:registry"] = opts.services.skillsRegistry;
  if (opts.services?.configStore) services["config:store"] = opts.services.configStore;

  const ctx: any = {
    cwd: opts.cwd,
    env,
    log: mock(() => {}),
    emit: mock(async () => {}),
    on: mock((event: string, fn: Function) => {
      (subscribers[event] ??= []).push(fn);
      return () => { subscribers[event] = (subscribers[event] ?? []).filter(f => f !== fn); };
    }),
    consumeService: mock((_id: string) => {}),
    useService: mock(<T>(id: string) => services[id] as T | undefined),
    provideService: mock(() => {}),
  };
  return { ctx, subscribers };
}

function makeFakeSkillsRegistry() {
  const registered: { name: string; baseDir?: string }[] = [];
  const unregisters: Record<string, () => void> = {};
  return {
    registered,
    unregisters,
    service: {
      list: () => [],
      load: async () => "",
      rescan: async () => ({ changed: false, count: 0 }),
      register: (manifest: any, _loader: any) => {
        registered.push({ name: manifest.name, baseDir: manifest.baseDir });
        const u = mock(() => {});
        unregisters[manifest.name] = u;
        return u;
      },
    },
  };
}

function makeFakeConfigStore(initial = { rescanIntervalMs: 30000 }) {
  let current = { ...initial };
  const watchers: Array<(next: any) => void> = [];
  const specs: any[] = [];
  return {
    push(next: any) { current = { ...current, ...next }; for (const w of watchers) w(current); },
    specs,
    service: {
      register: (spec: any) => { specs.push(spec); },
      get: () => current,
      set: async () => {},
      watch: (_plugin: string, cb: (n: any) => void) => { watchers.push(cb); return () => {}; },
      list: () => [],
      ready: async () => {},
      unset: async () => {},
      getSpec: () => undefined,
    },
  };
}

describe("claude-skills plugin", () => {
  it("declares hard deps on skills:registry and config:store", () => {
    expect(plugin.services?.consumes).toContain("skills:registry");
    expect(plugin.services?.consumes).toContain("config:store");
  });

  it("calls consumeService for both services in setup", async () => {
    const { ctx } = makeCtx({
      services: {
        skillsRegistry: makeFakeSkillsRegistry().service,
        configStore: makeFakeConfigStore().service,
      },
    });
    await plugin.setup!(ctx);
    expect((ctx.consumeService as any).mock.calls.flat()).toContain("skills:registry");
    expect((ctx.consumeService as any).mock.calls.flat()).toContain("config:store");
  });

  it("throws if skills:registry is absent", async () => {
    const { ctx } = makeCtx({ services: { configStore: makeFakeConfigStore().service } });
    await expect(plugin.setup!(ctx)).rejects.toThrow();
  });

  it("throws if config:store is absent", async () => {
    const { ctx } = makeCtx({ services: { skillsRegistry: makeFakeSkillsRegistry().service } });
    await expect(plugin.setup!(ctx)).rejects.toThrow();
  });

  it("registers a config schema with claude-skills' rescanIntervalMs field", async () => {
    const skills = makeFakeSkillsRegistry();
    const config = makeFakeConfigStore();
    const { ctx } = makeCtx({ services: { skillsRegistry: skills.service, configStore: config.service } });
    await plugin.setup!(ctx);
    expect(config.specs.length).toBe(1);
    expect(config.specs[0].plugin).toBe("claude-skills");
    expect(config.specs[0].defaults.rescanIntervalMs).toBe(30000);
    expect(config.specs[0].envVars?.rescanIntervalMs).toBe("KAIZEN_CLAUDE_SKILLS_RESCAN_MS");
  });

  it("performs an initial scan and registers skills found in the user root", async () => {
    const skills = makeFakeSkillsRegistry();
    const config = makeFakeConfigStore();
    const { ctx } = makeCtx({
      cwd: "/tmp/does-not-exist-cwd",
      env: { HOME: join(FIXTURES, "three-roots/user") },
      services: { skillsRegistry: skills.service, configStore: config.service },
    });
    await plugin.setup!(ctx);
    const names = skills.registered.map(r => r.name).sort();
    expect(names).toContain("user-only");
    expect(names).toContain("shared");
  });

  it("subscribes to turn:start", async () => {
    const skills = makeFakeSkillsRegistry();
    const config = makeFakeConfigStore();
    const { ctx, subscribers } = makeCtx({
      services: { skillsRegistry: skills.service, configStore: config.service },
    });
    await plugin.setup!(ctx);
    expect((subscribers["turn:start"]?.length ?? 0)).toBeGreaterThan(0);
  });

  it("stop() unregisters every registered skill and is idempotent", async () => {
    const skills = makeFakeSkillsRegistry();
    const config = makeFakeConfigStore();
    const { ctx } = makeCtx({
      env: { HOME: join(FIXTURES, "three-roots/user") },
      services: { skillsRegistry: skills.service, configStore: config.service },
    });
    await plugin.setup!(ctx);
    const names = Object.keys(skills.unregisters);
    expect(names.length).toBeGreaterThan(0);

    await plugin.stop!(ctx);
    for (const n of names) {
      expect((skills.unregisters[n] as any).mock.calls.length).toBe(1);
    }

    await plugin.stop!(ctx);
    for (const n of names) {
      expect((skills.unregisters[n] as any).mock.calls.length).toBe(1);
    }
  });
});
