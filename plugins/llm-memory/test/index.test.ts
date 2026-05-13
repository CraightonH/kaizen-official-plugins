import { describe, it, expect } from "bun:test";
import plugin from "../index.ts";

describe("llm-memory metadata", () => {
  it("name + apiVersion", () => {
    expect(plugin.name).toBe("llm-memory");
    expect(plugin.apiVersion).toBe("3.0.0");
  });
  it("declares unscoped tier", () => {
    expect(plugin.permissions?.tier).toBe("unscoped");
  });
  it("provides memory:store", () => {
    expect(plugin.services?.provides).toContain("memory:store");
  });
  it("only hard-consumes events:vocabulary (other services degrade gracefully)", () => {
    expect(plugin.services?.consumes).toEqual(["events:vocabulary"]);
  });
});

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock } from "bun:test";

function makePromptSystem() {
  const sections: any[] = [];
  return {
    svc: {
      register: mock((section: any) => {
        sections.push(section);
        const handle = { bumpGeneration: mock(() => {}), unregister: mock(() => {}) };
        return handle;
      }),
      assemble: mock(async () => ""),
    },
    sections,
  };
}

function makeCtx(promptSystemSvc?: any, env: Record<string, string | undefined> = {}) {
  const services: Record<string, unknown> = {};
  const handlers: Record<string, Function[]> = {};
  if (promptSystemSvc) services["prompt:registry"] = promptSystemSvc;
  return {
    log: mock(() => {}),
    defineService: mock(() => {}),
    provideService: mock((name: string, impl: unknown) => { services[name] = impl; }),
    consumeService: mock(() => {}),
    useService: mock((name: string) => services[name]),
    on: mock((evt: string, h: Function) => { (handlers[evt] ??= []).push(h); }),
    emit: mock(async () => []),
    defineEvent: mock(() => {}),
    secrets: { get: mock(async () => undefined), refresh: mock(async () => undefined) },
    services,
    handlers,
  } as any;
}

describe("llm-memory setup wiring", () => {
  it("provides memory:store and registers prompt:system section (id=llm-memory:auto, priority=170)", async () => {
    const home = mkdtempSync(join(tmpdir(), "llm-memory-home-"));
    const orig = process.env.HOME;
    process.env.HOME = home;
    try {
      const { svc, sections } = makePromptSystem();
      const ctx = makeCtx(svc);
      await plugin.setup(ctx);
      expect(ctx.services["memory:store"]).toBeTruthy();
      expect(sections.length).toBe(1);
      expect(sections[0].id).toBe("llm-memory:auto");
      expect(sections[0].priority).toBe(170);
    } finally {
      if (orig !== undefined) process.env.HOME = orig;
    }
  });

  it("section has no title (approach A: block carries its own structure)", async () => {
    const home = mkdtempSync(join(tmpdir(), "llm-memory-home-"));
    const orig = process.env.HOME;
    process.env.HOME = home;
    try {
      const { svc, sections } = makePromptSystem();
      const ctx = makeCtx(svc);
      await plugin.setup(ctx);
      expect(sections[0].title).toBeUndefined();
    } finally {
      if (orig !== undefined) process.env.HOME = orig;
    }
  });

  it("does NOT subscribe llm:before-call", async () => {
    const home = mkdtempSync(join(tmpdir(), "llm-memory-home-"));
    const orig = process.env.HOME;
    process.env.HOME = home;
    try {
      const { svc } = makePromptSystem();
      const ctx = makeCtx(svc);
      await plugin.setup(ctx);
      expect(ctx.handlers["llm:before-call"]).toBeUndefined();
    } finally {
      if (orig !== undefined) process.env.HOME = orig;
    }
  });

  it("emits harness:error when prompt:system unavailable", async () => {
    const home = mkdtempSync(join(tmpdir(), "llm-memory-home-"));
    const orig = process.env.HOME;
    process.env.HOME = home;
    try {
      const ctx = makeCtx(undefined); // no prompt:system
      await plugin.setup(ctx);
      const calls: any[] = (ctx.emit as any).mock.calls;
      const errorCall = calls.find(([evt]: [string]) => evt === "harness:error");
      expect(errorCall).toBeTruthy();
      expect(errorCall[1].message).toMatch(/prompt:registry/);
      expect(errorCall[1].message).toMatch(/saved-memories section disabled/);
    } finally {
      if (orig !== undefined) process.env.HOME = orig;
    }
  });

  it("section render returns empty string (not null) when no memories exist", async () => {
    const home = mkdtempSync(join(tmpdir(), "llm-memory-home-"));
    const orig = process.env.HOME;
    process.env.HOME = home;
    try {
      const { svc, sections } = makePromptSystem();
      const ctx = makeCtx(svc);
      await plugin.setup(ctx);
      const result = await sections[0].render();
      expect(result).toBe("");
    } finally {
      if (orig !== undefined) process.env.HOME = orig;
    }
  });

  it("bumpGeneration is called after store.put (via onChange)", async () => {
    const home = mkdtempSync(join(tmpdir(), "llm-memory-home-"));
    const orig = process.env.HOME;
    process.env.HOME = home;
    try {
      const { svc, sections } = makePromptSystem();
      const ctx = makeCtx(svc);
      await plugin.setup(ctx);
      const store = ctx.services["memory:store"] as any;
      const handle = (svc.register as any).mock.results[0].value;
      const bumpBefore = (handle.bumpGeneration as any).mock.calls.length;
      await store.put({ name: "x", description: "d", type: "user", scope: "global", body: "B" });
      expect((handle.bumpGeneration as any).mock.calls.length).toBeGreaterThan(bumpBefore);
    } finally {
      if (orig !== undefined) process.env.HOME = orig;
    }
  });

  it("does not subscribe turn:end when autoExtract default (false)", async () => {
    const home = mkdtempSync(join(tmpdir(), "llm-memory-home-"));
    const orig = process.env.HOME;
    process.env.HOME = home;
    try {
      const { svc } = makePromptSystem();
      const ctx = makeCtx(svc);
      await plugin.setup(ctx);
      expect(ctx.handlers["turn:end"]).toBeUndefined();
    } finally {
      if (orig !== undefined) process.env.HOME = orig;
    }
  });
});
