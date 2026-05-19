import { describe, it, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../index.ts";

interface FakeCtx {
  provided: Record<string, unknown>;
  defined: string[];
  consumed: string[];
  services: Record<string, any>;
  events: Record<string, Array<(p: any) => any>>;
  emitted: Array<{ event: string; payload: any }>;
  log: (m: string) => void;
  logs: string[];
}

function makeCtx(): FakeCtx & {
  provideService: (n: string, s: unknown) => void;
  defineService: (n: string, _spec: any) => void;
  consumeService: (n: string) => void;
  useService: <T>(n: string) => T | undefined;
  on: (event: string, cb: (p: any) => any) => void;
  emit: (event: string, payload: any) => Promise<void>;
} {
  const provided: Record<string, unknown> = {};
  const defined: string[] = [];
  const consumed: string[] = [];
  const services: Record<string, any> = {};
  const events: Record<string, Array<(p: any) => any>> = {};
  const emitted: Array<{ event: string; payload: any }> = [];
  const logs: string[] = [];
  return {
    provided, defined, consumed, services, events, emitted, logs,
    log: (m: string) => { logs.push(m); },
    provideService(n, s) { provided[n] = s; services[n] = s; },
    defineService(n) { defined.push(n); },
    consumeService(n) { consumed.push(n); },
    useService<T>(n: string): T | undefined { return services[n] as T | undefined; },
    on(event, cb) { (events[event] ??= []).push(cb); },
    async emit(event, payload) {
      emitted.push({ event, payload });
      for (const cb of events[event] ?? []) await cb(payload);
    },
  };
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "llm-axioms-index-")); });

describe("plugin manifest", () => {
  it("has the expected manifest fields", () => {
    expect(plugin.name).toBe("llm-axioms");
    expect(plugin.services?.provides).toContain("axioms:registry");
    expect(plugin.services?.consumes).toContain("events:vocabulary");
    expect(plugin.services?.consumes).toContain("prompt:registry");
    expect(plugin.services?.consumes).toContain("tools:registry");
    expect(plugin.services?.consumes).toContain("slash:registry");
    expect(plugin.services?.consumes).toContain("config:store");
  });
});

describe("setup", () => {
  it("provides axioms:registry", async () => {
    const ctx = makeCtx();
    // simulate config:store
    ctx.services["config:store"] = {
      register: () => {},
      get: () => ({ axiomsDir: dir, injectionByteCap: 4096, methodologyEnabled: true, workspaceEnabled: true, staleTempMs: 60000 }),
    };
    await plugin.setup!(ctx as any);
    expect(ctx.provided["axioms:registry"]).toBeDefined();
  });

  it("registers both prompt sections when prompt:registry is present", async () => {
    const ctx = makeCtx();
    const sections: any[] = [];
    ctx.services["prompt:registry"] = {
      register(section: any) {
        sections.push(section);
        return { unregister: () => {}, bumpGeneration: () => {} };
      },
    };
    ctx.services["config:store"] = {
      register: () => {},
      get: () => ({ axiomsDir: dir, injectionByteCap: 4096, methodologyEnabled: true, workspaceEnabled: true, staleTempMs: 60000 }),
    };
    await plugin.setup!(ctx as any);
    const ids = sections.map((s) => s.id);
    expect(ids).toContain("llm-axioms:methodology");
    expect(ids).toContain("llm-axioms:workspace");
  });

  it("skips section registration when methodologyEnabled / workspaceEnabled are false", async () => {
    const ctx = makeCtx();
    const sections: any[] = [];
    ctx.services["prompt:registry"] = {
      register(section: any) {
        sections.push(section);
        return { unregister: () => {}, bumpGeneration: () => {} };
      },
    };
    ctx.services["config:store"] = {
      register: () => {},
      get: () => ({ axiomsDir: dir, injectionByteCap: 4096, methodologyEnabled: false, workspaceEnabled: false, staleTempMs: 60000 }),
    };
    await plugin.setup!(ctx as any);
    expect(sections.length).toBe(0);
  });

  it("registers tools when tools:registry is present", async () => {
    const ctx = makeCtx();
    const tools: string[] = [];
    ctx.services["tools:registry"] = {
      register(schema: any) { tools.push(schema.name); return () => {}; },
    };
    ctx.services["config:store"] = {
      register: () => {},
      get: () => ({ axiomsDir: dir, injectionByteCap: 4096, methodologyEnabled: true, workspaceEnabled: true, staleTempMs: 60000 }),
    };
    await plugin.setup!(ctx as any);
    expect(tools.sort()).toEqual(["axiom_amend", "axiom_drop", "axiom_record"]);
  });

  it("registers slash commands when slash:registry is present", async () => {
    const ctx = makeCtx();
    const slashes: string[] = [];
    ctx.services["slash:registry"] = {
      register(manifest: any) { slashes.push(manifest.name); return () => {}; },
    };
    ctx.services["config:store"] = {
      register: () => {},
      get: () => ({ axiomsDir: dir, injectionByteCap: 4096, methodologyEnabled: true, workspaceEnabled: true, staleTempMs: 60000 }),
    };
    await plugin.setup!(ctx as any);
    expect(slashes.sort()).toEqual(["axioms:clear", "axioms:list", "axioms:show"]);
  });

  it("subscribes to session:active-changed and swaps store session", async () => {
    const ctx = makeCtx();
    ctx.services["config:store"] = {
      register: () => {},
      get: () => ({ axiomsDir: dir, injectionByteCap: 4096, methodologyEnabled: true, workspaceEnabled: true, staleTempMs: 60000 }),
    };
    await plugin.setup!(ctx as any);
    expect(ctx.events["session:active-changed"]?.length ?? 0).toBeGreaterThan(0);
    // After firing the event with a sessionId, the store should be writable.
    await ctx.emit("session:active-changed", { sessionId: "sess-test" });
    const svc = ctx.provided["axioms:registry"] as any;
    await svc.record({ id: "a1", statement: "S", premises: ["p"], reasoning: "r", scope: "z" });
    expect(svc.list().length).toBe(1);
  });

  it("degrades gracefully when config:store is absent (uses defaults)", async () => {
    const ctx = makeCtx();
    // No config:store
    await plugin.setup!(ctx as any);
    expect(ctx.provided["axioms:registry"]).toBeDefined();
  });
});

describe("stop", () => {
  it("is idempotent — second call is a no-op", async () => {
    const ctx = makeCtx();
    ctx.services["config:store"] = {
      register: () => {},
      get: () => ({ axiomsDir: dir, injectionByteCap: 4096, methodologyEnabled: true, workspaceEnabled: true, staleTempMs: 60000 }),
    };
    ctx.services["prompt:registry"] = {
      register: () => ({ unregister: () => {}, bumpGeneration: () => {} }),
    };
    ctx.services["tools:registry"] = { register: () => () => {} };
    ctx.services["slash:registry"] = { register: () => () => {} };
    await plugin.setup!(ctx as any);
    await plugin.stop!(ctx as any);
    await plugin.stop!(ctx as any);
  });
});
