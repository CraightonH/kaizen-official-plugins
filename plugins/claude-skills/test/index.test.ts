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
  services?: FakeServices;
} = {}) {
  const subscribers: Record<string, Function[]> = {};
  const services: Record<string, unknown> = {};
  if (opts.services?.skillsRegistry) services["skills:registry"] = opts.services.skillsRegistry;
  if (opts.services?.configStore) services["config:store"] = opts.services.configStore;

  const ctx: any = {
    cwd: opts.cwd,
    log: mock(() => {}),
    emit: mock(async () => {}),
    on: mock((event: string, fn: Function) => {
      (subscribers[event] ??= []).push(fn);
      return () => { subscribers[event] = (subscribers[event] ?? []).filter(f => f !== fn); };
    }),
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
  it("declares skills:registry and config:store in services.consumes", () => {
    expect(plugin.services?.consumes).toContain("skills:registry");
    expect(plugin.services?.consumes).toContain("config:store");
  });

  it("throws if skills:registry is absent", async () => {
    const { ctx } = makeCtx({ services: { configStore: makeFakeConfigStore().service } });
    await expect(plugin.setup!(ctx)).rejects.toThrow();
  });

  it("falls back to DEFAULT_CONFIG when config:store is absent (topo-hint optional)", async () => {
    const skills = makeFakeSkillsRegistry();
    const { ctx } = makeCtx({ services: { skillsRegistry: skills.service } });
    // Should not throw; should log a fallback notice and continue boot.
    await expect(plugin.setup!(ctx)).resolves.toBeUndefined();
  });

  it("registers a config schema with claude-skills' rescanIntervalMs field and no envVars", async () => {
    const skills = makeFakeSkillsRegistry();
    const config = makeFakeConfigStore();
    const { ctx } = makeCtx({ services: { skillsRegistry: skills.service, configStore: config.service } });
    await plugin.setup!(ctx);
    expect(config.specs.length).toBe(1);
    expect(config.specs[0].plugin).toBe("claude-skills");
    expect(config.specs[0].defaults.rescanIntervalMs).toBe(30000);
    // Env-var support is intentionally dropped in pass-2 migration.
    expect(config.specs[0].envVars).toBeUndefined();
  });

  it("performs an initial scan and registers skills found in the project root", async () => {
    const skills = makeFakeSkillsRegistry();
    const config = makeFakeConfigStore();
    const { ctx } = makeCtx({
      // Project root is derived from ctx.cwd; user/plugin-cache roots come
      // from homedir() and won't resolve to the fixture tree.
      cwd: join(FIXTURES, "three-roots/project"),
      services: { skillsRegistry: skills.service, configStore: config.service },
    });
    await plugin.setup!(ctx);
    const names = skills.registered.map(r => r.name).sort();
    expect(names).toContain("proj-only");
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
      cwd: join(FIXTURES, "three-roots/project"),
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
