import { describe, it, expect, mock } from "bun:test";
import { makeInjector } from "../injector.ts";
import { makeRegistry, makeRegistryHandle } from "../registry.ts";
import { makeTurnTracker } from "../turn-tracker.ts";
import type { InternalAgentManifest } from "../frontmatter.ts";

function m(name: string, description: string): InternalAgentManifest {
  return { name, description, systemPrompt: "p", sourcePath: "/x", scope: "user" };
}

function makeCtx() {
  const subs: Record<string, ((p: any) => any)[]> = {};
  return {
    subs,
    on: mock((event: string, fn: any) => { (subs[event] ??= []).push(fn); }),
    emit: async (event: string, payload: any) => {
      for (const f of subs[event] ?? []) await f(payload);
    },
  } as any;
}

describe("injector", () => {
  it("appends 'Available agents' section once per top-level turn", async () => {
    const reg = makeRegistryHandle(makeRegistry([m("code-reviewer", "review code"), m("doc-writer", "write docs")]));
    const tracker = makeTurnTracker();
    const ctx = makeCtx();
    makeInjector({ ctx, registry: reg, tracker });

    // Top-level turn starts
    await ctx.emit("turn:start", { turnId: "t1", trigger: "user" });
    const req: any = { systemPrompt: "BASE", model: "x", messages: [] };
    await ctx.emit("llm:before-call", { request: req, turnId: "t1" });
    expect(req.systemPrompt).toContain("BASE");
    expect(req.systemPrompt).toContain("## Available agents");
    expect(req.systemPrompt).toContain("- code-reviewer: review code");

    // Second LLM call in same turn — no double-inject
    const before = req.systemPrompt;
    await ctx.emit("llm:before-call", { request: req, turnId: "t1" });
    expect(req.systemPrompt).toBe(before);
  });

  it("does not inject for nested (agent) turns", async () => {
    const reg = makeRegistryHandle(makeRegistry([m("a", "d")]));
    const tracker = makeTurnTracker();
    const ctx = makeCtx();
    makeInjector({ ctx, registry: reg, tracker });

    await ctx.emit("turn:start", { turnId: "t1", trigger: "agent", parentTurnId: "t0" });
    const req: any = { systemPrompt: "BASE", model: "x", messages: [] };
    await ctx.emit("llm:before-call", { request: req, turnId: "t1" });
    expect(req.systemPrompt).toBe("BASE");
  });

  it("empty registry omits the section", async () => {
    const reg = makeRegistryHandle(makeRegistry([]));
    const tracker = makeTurnTracker();
    const ctx = makeCtx();
    makeInjector({ ctx, registry: reg, tracker });
    await ctx.emit("turn:start", { turnId: "t1", trigger: "user" });
    const req: any = { systemPrompt: "BASE", model: "x", messages: [] };
    await ctx.emit("llm:before-call", { request: req, turnId: "t1" });
    expect(req.systemPrompt).toBe("BASE");
  });

  it("injection set is cleared on turn:end so a new top-level turn re-injects", async () => {
    const reg = makeRegistryHandle(makeRegistry([m("a", "d")]));
    const tracker = makeTurnTracker();
    const ctx = makeCtx();
    makeInjector({ ctx, registry: reg, tracker });

    await ctx.emit("turn:start", { turnId: "t1", trigger: "user" });
    const req1: any = { systemPrompt: "B", model: "x", messages: [] };
    await ctx.emit("llm:before-call", { request: req1, turnId: "t1" });
    expect(req1.systemPrompt).toContain("Available agents");
    await ctx.emit("turn:end", { turnId: "t1", reason: "complete" });

    await ctx.emit("turn:start", { turnId: "t2", trigger: "user" });
    const req2: any = { systemPrompt: "B", model: "x", messages: [] };
    await ctx.emit("llm:before-call", { request: req2, turnId: "t2" });
    expect(req2.systemPrompt).toContain("Available agents");
  });
});
