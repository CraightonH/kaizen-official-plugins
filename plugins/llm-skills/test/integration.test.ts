import { describe, it, expect, mock } from "bun:test";
import { join } from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import plugin from "../index.ts";

const FIXTURES = join(import.meta.dir, "fixtures");

// Minimal in-process tools:registry that mirrors the Spec 0 contract for the
// purpose of this integration test. Real implementation lives in
// `llm-tools-registry` (Spec 3); we don't import it here to keep the plugin's
// tests self-contained.
function fakeToolsRegistry(emit: (e: string, p: unknown) => Promise<void>) {
  const tools = new Map<string, { schema: any; handler: any }>();
  return {
    registerWith(reg: any) {
      tools.set(reg.schema.name, { schema: reg.schema, handler: reg.handler });
      return () => { tools.delete(reg.schema.name); };
    },
    register(schema: any, handler: any) {
      tools.set(schema.name, { schema, handler });
      return () => { tools.delete(schema.name); };
    },
    list(filter?: any) {
      const all = [...tools.values()].map(t => t.schema);
      if (!filter?.tags) return all;
      return all.filter(s => (s.tags ?? []).some((t: string) => filter.tags.includes(t)));
    },
    async invoke(name: string, args: unknown, ctx: any) {
      const t = tools.get(name);
      if (!t) throw new Error(`unknown tool: ${name}`);
      await emit("tool:before-execute", { name, args, callId: ctx.callId });
      try {
        await emit("tool:execute", { name, args, callId: ctx.callId });
        const result = await t.handler(args, ctx);
        await emit("tool:result", { name, callId: ctx.callId, result });
        return result;
      } catch (err: any) {
        await emit("tool:error", { name, callId: ctx.callId, message: String(err.message ?? err) });
        throw err;
      }
    },
  };
}

function fakePromptSystem() {
  const sections: any[] = [];
  return {
    service: {
      register: (section: any) => {
        sections.push(section);
        return { bumpGeneration: () => {}, unregister: () => {} };
      },
      assemble: async () => "",
      list: () => sections.map(s => ({ id: s.id, priority: s.priority, title: s.title })),
      generation: () => 0,
    },
    sections,
  };
}

describe("integration — llm-skills against a fake tools:registry", () => {
  it("dispatches load_skill end-to-end and emits events in order", async () => {
    const subscribers: Record<string, Function[]> = {};
    const emittedOrder: string[] = [];
    const emit = async (name: string, payload: unknown) => {
      emittedOrder.push(name);
      for (const fn of subscribers[name] ?? []) await fn(payload);
    };
    const tools = fakeToolsRegistry(emit);
    const ps = fakePromptSystem();

    const ctx: any = {
      cwd: "/does-not-exist",
      env: { KAIZEN_LLM_SKILLS_PATH: join(FIXTURES, "ok-flat") },
      log: mock(() => {}),
      defineEvent: () => {},
      on: (event: string, fn: Function) => { (subscribers[event] ??= []).push(fn); },
      emit,
      defineService: () => {},
      provideService: () => {},
      consumeService: () => {},
      useService: (name: string) => {
        if (name === "tools:registry") return tools;
        if (name === "prompt:registry") return ps.service;
        return undefined;
      },
      secrets: { get: async () => undefined, refresh: async () => undefined },
    };

    await plugin.setup(ctx);

    // 1. prompt:system section is registered (no llm:before-call injection).
    const section = ps.sections.find((s: any) => s.id === "llm-skills:available");
    expect(section).toBeDefined();
    const rendered = await section.render();
    expect(rendered).toContain("- git-rebase");
    expect(rendered.includes("## Available skills")).toBe(false);

    // 2. No llm:before-call subscriber.
    expect(subscribers["llm:before-call"]).toBeUndefined();

    // 3. Invoke load_skill via the registry.
    const result = await tools.invoke("load_skill", { name: "git-rebase" }, {
      signal: new AbortController().signal,
      callId: "call-1",
      log: () => {},
    });
    expect(result).toMatchObject({ name: "git-rebase", body: expect.stringContaining("Step 1") });

    // 4. Event ordering: before-execute → execute → skill:loaded → tool:result.
    const idxBefore = emittedOrder.indexOf("tool:before-execute");
    const idxExec = emittedOrder.indexOf("tool:execute");
    const idxLoaded = emittedOrder.indexOf("skill:loaded");
    const idxResult = emittedOrder.indexOf("tool:result");
    expect(idxBefore).toBeGreaterThanOrEqual(0);
    expect(idxExec).toBeGreaterThan(idxBefore);
    expect(idxLoaded).toBeGreaterThan(idxExec);
    expect(idxResult).toBeGreaterThan(idxLoaded);
  });

  it("surfaces tool:error when load_skill is called with bad args", async () => {
    const subscribers: Record<string, Function[]> = {};
    const emittedOrder: string[] = [];
    const emit = async (name: string, payload: unknown) => {
      emittedOrder.push(name);
      for (const fn of subscribers[name] ?? []) await fn(payload);
    };
    const tools = fakeToolsRegistry(emit);
    const ps = fakePromptSystem();
    const ctx: any = {
      cwd: "/does-not-exist",
      env: { KAIZEN_LLM_SKILLS_PATH: join(FIXTURES, "ok-flat") },
      log: () => {},
      defineEvent: () => {},
      on: (event: string, fn: Function) => { (subscribers[event] ??= []).push(fn); },
      emit,
      defineService: () => {},
      provideService: () => {},
      consumeService: () => {},
      useService: (name: string) => {
        if (name === "tools:registry") return tools;
        if (name === "prompt:registry") return ps.service;
        return undefined;
      },
      secrets: { get: async () => undefined, refresh: async () => undefined },
    };
    await plugin.setup(ctx);
    await expect(
      tools.invoke("load_skill", {}, { signal: new AbortController().signal, callId: "c2", log: () => {} }),
    ).rejects.toThrow(/name/i);
    expect(emittedOrder).toContain("tool:error");
  });
});

describe("integration — new_skill end-to-end through fake tools:registry", () => {
  it("writes a SKILL.md, registers it, and load_skill returns its body", async () => {
    const userRoot = await mkdtemp(join(tmpdir(), "ns-user-"));
    const subscribers: Record<string, Function[]> = {};
    const emittedOrder: string[] = [];
    const emit = async (name: string, payload: unknown) => {
      emittedOrder.push(name);
      for (const fn of subscribers[name] ?? []) await fn(payload);
    };
    const tools = fakeToolsRegistry(emit);

    // Track bumpGeneration calls for the new_skill test.
    let bumpCount = 0;
    const ps = fakePromptSystem();
    const origRegister = ps.service.register;
    ps.service.register = (section: any) => {
      const result = origRegister.call(ps.service, section);
      const origBump = result.bumpGeneration;
      result.bumpGeneration = () => { bumpCount++; origBump(); };
      return result;
    };

    const ctx: any = {
      cwd: "/does-not-exist",
      env: { KAIZEN_LLM_SKILLS_PATH: userRoot },
      log: mock(() => {}),
      defineEvent: () => {},
      on: (event: string, fn: Function) => { (subscribers[event] ??= []).push(fn); },
      emit,
      defineService: () => {},
      provideService: () => {},
      consumeService: () => {},
      useService: (name: string) => {
        if (name === "tools:registry") return tools;
        if (name === "prompt:registry") return ps.service;
        return undefined;
      },
      secrets: { get: async () => undefined, refresh: async () => undefined },
    };

    await plugin.setup(ctx);

    // 1. Call new_skill through the registry. Capture bump count before.
    const bumpBefore = bumpCount;
    const newResult = await tools.invoke("new_skill", {
      name: "demo",
      description: "Demo skill.",
      body: "Hello from the demo skill.",
      scope: "user",
    }, { signal: new AbortController().signal, callId: "c-new", log: () => {} }) as any;
    expect(newResult.name).toBe("demo");
    expect(newResult.scope).toBe("user");
    expect(newResult.path).toBe(join(userRoot, "demo", "SKILL.md"));
    expect(newResult.tokens).toBeGreaterThan(0);
    // Prompt-section generation bump happened after new_skill write.
    expect(bumpCount).toBeGreaterThan(bumpBefore);

    // 2. File is on disk.
    const fileText = await readFile(join(userRoot, "demo", "SKILL.md"), "utf8");
    expect(fileText).toContain("name: demo");
    expect(fileText).toContain("Hello from the demo skill.");

    // 3. load_skill now sees the new skill.
    const loadResult = await tools.invoke("load_skill", { name: "demo" }, {
      signal: new AbortController().signal, callId: "c-load", log: () => {},
    }) as any;
    expect(loadResult.body).toContain("Hello from the demo skill.");

    // 4. skill:available-changed emitted after the new_skill write (one for
    //    initial empty scan, one for the post-write rescan-change).
    const changeCount = emittedOrder.filter(n => n === "skill:available-changed").length;
    expect(changeCount).toBeGreaterThanOrEqual(2);

    await rm(userRoot, { recursive: true });
  });
});
