import { describe, it, expect, mock } from "bun:test";
import { join } from "node:path";
import plugin from "../index.ts";

const FIXTURES = join(import.meta.dir, "fixtures");

// Minimal in-process tools:registry that mirrors the Spec 0 contract for the
// purpose of this integration test. Real implementation lives in
// `llm-tools-registry` (Spec 3); we don't import it here to keep the plugin's
// tests self-contained.
function fakeToolsRegistry(emit: (e: string, p: unknown) => Promise<void>) {
  const tools = new Map<string, { schema: any; handler: any }>();
  return {
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

describe("integration — llm-skills against a fake tools:registry", () => {
  it("injects prompt and dispatches load_skill end-to-end", async () => {
    const subscribers: Record<string, Function[]> = {};
    const emittedOrder: string[] = [];
    const emit = async (name: string, payload: unknown) => {
      emittedOrder.push(name);
      for (const fn of subscribers[name] ?? []) await fn(payload);
    };
    const tools = fakeToolsRegistry(emit);

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
      useService: (name: string) => (name === "tools:registry" ? tools : undefined),
      secrets: { get: async () => undefined, refresh: async () => undefined },
    };

    await plugin.setup(ctx);

    // 1. llm:before-call mutates request.systemPrompt.
    const req: any = { systemPrompt: "you are a helper", model: "x", messages: [] };
    await emit("llm:before-call", { request: req });
    expect(req.systemPrompt).toContain("## Available skills");
    expect(req.systemPrompt).toContain("- git-rebase");

    // 2. Invoke load_skill via the registry.
    const result = await tools.invoke("load_skill", { name: "git-rebase" }, {
      signal: new AbortController().signal,
      callId: "call-1",
      log: () => {},
    });
    expect(result).toMatchObject({ name: "git-rebase", body: expect.stringContaining("Step 1") });

    // 3. Event ordering: before-execute → execute → skill:loaded → tool:result.
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
      useService: (name: string) => (name === "tools:registry" ? tools : undefined),
      secrets: { get: async () => undefined, refresh: async () => undefined },
    };
    await plugin.setup(ctx);
    await expect(
      tools.invoke("load_skill", {}, { signal: new AbortController().signal, callId: "c2", log: () => {} }),
    ).rejects.toThrow(/name/i);
    expect(emittedOrder).toContain("tool:error");
  });
});
