import { describe, it, expect, mock } from "bun:test";
import { makeInjector, buildAgentsBlock } from "../injector.ts";
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

describe("buildAgentsBlock", () => {
  it("returns empty string when no agents", () => {
    expect(buildAgentsBlock([])).toBe("");
  });

  it("returns bullet list without heading", () => {
    const result = buildAgentsBlock([
      { name: "code-reviewer", description: "review code" },
      { name: "doc-writer", description: "write docs" },
    ]);
    expect(result).toBe("- code-reviewer: review code\n- doc-writer: write docs");
    expect(result).not.toContain("##");
    expect(result).not.toContain("Available agents");
  });

  it("truncates long descriptions to 200 chars", () => {
    const longDesc = "x".repeat(250);
    const result = buildAgentsBlock([{ name: "a", description: longDesc }]);
    expect(result).toContain("...");
    const bulletContent = result.replace("- a: ", "");
    expect(bulletContent.length).toBe(200);
  });

  it("collapses whitespace in descriptions", () => {
    const result = buildAgentsBlock([{ name: "a", description: "line1\n  line2\t  line3" }]);
    expect(result).toBe("- a: line1 line2 line3");
  });
});

describe("makeInjector — turn-tracker wiring", () => {
  it("subscribes to turn:start and turn:end only (no llm:before-call)", () => {
    const reg = makeRegistryHandle(makeRegistry([m("a", "d")]));
    const tracker = makeTurnTracker();
    const ctx = makeCtx();
    makeInjector({ ctx, registry: reg, tracker });

    const subscribedEvents = (ctx.on as any).mock.calls.map((c: any) => c[0]);
    expect(subscribedEvents).toContain("turn:start");
    expect(subscribedEvents).toContain("turn:end");
    expect(subscribedEvents).not.toContain("llm:before-call");
  });

  it("turn:start updates the tracker (depth tracking)", async () => {
    const reg = makeRegistryHandle(makeRegistry([]));
    const tracker = makeTurnTracker();
    const ctx = makeCtx();
    makeInjector({ ctx, registry: reg, tracker });

    await ctx.emit("turn:start", { turnId: "t1", trigger: "user" });
    expect(tracker.isTopLevel("t1")).toBe(true);

    await ctx.emit("turn:start", { turnId: "t2", trigger: "agent", parentTurnId: "t1" });
    expect(tracker.isTopLevel("t2")).toBe(false);
  });

  it("turn:end clears the tracker record", async () => {
    const reg = makeRegistryHandle(makeRegistry([]));
    const tracker = makeTurnTracker();
    const ctx = makeCtx();
    makeInjector({ ctx, registry: reg, tracker });

    await ctx.emit("turn:start", { turnId: "t1", trigger: "user" });
    await ctx.emit("turn:end", { turnId: "t1" });
    // After turn:end the tracker no longer has this turn; isTopLevel returns false
    expect(tracker.isTopLevel("t1")).toBe(false);
  });
});
