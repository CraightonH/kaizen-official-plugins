import { describe, it, expect, mock } from "bun:test";
import { makeDispatchTool } from "../dispatch.ts";
import { makeRegistry, makeRegistryHandle } from "../registry.ts";
import { makeTurnTracker } from "../turn-tracker.ts";
import type { InternalAgentManifest } from "../frontmatter.ts";

function m(name: string): InternalAgentManifest {
  return {
    name,
    description: `agent ${name}`,
    systemPrompt: `you are ${name}`,
    toolFilter: { names: ["read_*"] },
    sourcePath: "/x",
    scope: "user",
  };
}

function makeCtx(turnId = "t-parent") {
  const events: { event: string; payload: any }[] = [];
  return {
    events,
    signal: new AbortController().signal,
    callId: "c1",
    turnId,
    log: () => {},
    emit: async (e: string, p: any) => { events.push({ event: e, payload: p }); },
  } as any;
}

describe("dispatch_agent", () => {
  it("happy path: invokes runConversation with manifest prompt and parentTurnId", async () => {
    const reg = makeRegistryHandle(makeRegistry([m("code-reviewer")]));
    const tracker = makeTurnTracker();
    tracker.onTurnStart({ turnId: "t-parent", trigger: "user" });
    const driver = {
      runConversation: mock(async (input: any) => ({
        finalMessage: { role: "assistant", content: "RESULT" },
        messages: [],
        usage: { promptTokens: 1, completionTokens: 1 },
      })),
    };
    const tool = makeDispatchTool({
      registry: reg, tracker, driver,
      maxDepth: 3,
      hasSkills: () => false,
    });
    const ctx = makeCtx();
    const result = await tool.handler({ agent_name: "code-reviewer", prompt: "look at file X" }, ctx);
    expect(result).toBe("RESULT");
    expect(driver.runConversation).toHaveBeenCalledTimes(1);
    const arg = (driver.runConversation as any).mock.calls[0][0];
    expect(arg.systemPrompt).toBe("you are code-reviewer");
    expect(arg.messages).toEqual([{ role: "user", content: "look at file X" }]);
    expect(arg.parentTurnId).toBe("t-parent");
    // Always-on dispatch_agent must be present in the filter:
    expect(arg.toolFilter.names).toContain("dispatch_agent");
    // Manifest filter preserved:
    expect(arg.toolFilter.names).toContain("read_*");
  });

  it("includes load_skill when skills service available", async () => {
    const reg = makeRegistryHandle(makeRegistry([m("a")]));
    const tracker = makeTurnTracker();
    tracker.onTurnStart({ turnId: "t-parent", trigger: "user" });
    const driver = { runConversation: async () => ({ finalMessage: { role: "assistant", content: "" }, messages: [], usage: { promptTokens: 0, completionTokens: 0 } }) };
    const tool = makeDispatchTool({ registry: reg, tracker, driver, maxDepth: 3, hasSkills: () => true });
    let captured: any;
    (driver as any).runConversation = async (input: any) => { captured = input; return { finalMessage: { role: "assistant", content: "" }, messages: [], usage: { promptTokens: 0, completionTokens: 0 } }; };
    await tool.handler({ agent_name: "a", prompt: "p" }, makeCtx());
    expect(captured.toolFilter.names).toContain("load_skill");
  });

  it("unknown agent throws tool error with Spec 11 message", async () => {
    const reg = makeRegistryHandle(makeRegistry([m("a"), m("b")]));
    const tracker = makeTurnTracker();
    tracker.onTurnStart({ turnId: "t-parent", trigger: "user" });
    const tool = makeDispatchTool({ registry: reg, tracker, driver: { runConversation: async () => ({} as any) }, maxDepth: 3, hasSkills: () => false });
    await expect(tool.handler({ agent_name: "ghost", prompt: "p" }, makeCtx())).rejects.toThrow(/Unknown agent 'ghost'.*Known: a, b/);
  });

  it("depth limit returns canonical error", async () => {
    const reg = makeRegistryHandle(makeRegistry([m("a")]));
    const tracker = makeTurnTracker();
    tracker.onTurnStart({ turnId: "t0", trigger: "user" });
    tracker.onTurnStart({ turnId: "t1", trigger: "agent", parentTurnId: "t0" });
    tracker.onTurnStart({ turnId: "t2", trigger: "agent", parentTurnId: "t1" });
    tracker.onTurnStart({ turnId: "t3", trigger: "agent", parentTurnId: "t2" });
    const tool = makeDispatchTool({ registry: reg, tracker, driver: { runConversation: async () => ({} as any) }, maxDepth: 3, hasSkills: () => false });
    const ctx = makeCtx("t3");
    await expect(tool.handler({ agent_name: "a", prompt: "p" }, ctx)).rejects.toThrow(/depth limit reached \(max=3\)/);
  });

  it("propagates parent's signal as input.signal", async () => {
    const reg = makeRegistryHandle(makeRegistry([m("a")]));
    const tracker = makeTurnTracker();
    tracker.onTurnStart({ turnId: "tp", trigger: "user" });
    let captured: AbortSignal | undefined;
    const driver = { runConversation: async (input: any) => { captured = input.signal; return { finalMessage: { role: "assistant", content: "" }, messages: [], usage: { promptTokens: 0, completionTokens: 0 } }; } };
    const tool = makeDispatchTool({ registry: reg, tracker, driver, maxDepth: 3, hasSkills: () => false });
    const ac = new AbortController();
    const ctx = { ...makeCtx("tp"), signal: ac.signal };
    await tool.handler({ agent_name: "a", prompt: "p" }, ctx as any);
    expect(captured).toBe(ac.signal);
  });

  it("AbortError from runConversation surfaces as cancelled tool error", async () => {
    const reg = makeRegistryHandle(makeRegistry([m("a")]));
    const tracker = makeTurnTracker();
    tracker.onTurnStart({ turnId: "tp", trigger: "user" });
    const driver = { runConversation: async () => { const e: any = new Error("aborted"); e.name = "AbortError"; throw e; } };
    const tool = makeDispatchTool({ registry: reg, tracker, driver, maxDepth: 3, hasSkills: () => false });
    await expect(tool.handler({ agent_name: "a", prompt: "p" }, makeCtx("tp"))).rejects.toThrow(/Agent 'a' cancelled/);
  });

  it("non-Abort errors are wrapped with 'failed: <inner>'", async () => {
    const reg = makeRegistryHandle(makeRegistry([m("a")]));
    const tracker = makeTurnTracker();
    tracker.onTurnStart({ turnId: "tp", trigger: "user" });
    const driver = { runConversation: async () => { throw new Error("boom"); } };
    const tool = makeDispatchTool({ registry: reg, tracker, driver, maxDepth: 3, hasSkills: () => false });
    await expect(tool.handler({ agent_name: "a", prompt: "p" }, makeCtx("tp"))).rejects.toThrow(/Agent 'a' failed: boom/);
  });

  it("rejects malformed inputs", async () => {
    const reg = makeRegistryHandle(makeRegistry([m("a")]));
    const tracker = makeTurnTracker();
    tracker.onTurnStart({ turnId: "tp", trigger: "user" });
    const tool = makeDispatchTool({ registry: reg, tracker, driver: { runConversation: async () => ({} as any) }, maxDepth: 3, hasSkills: () => false });
    await expect(tool.handler({ agent_name: 1, prompt: "p" } as any, makeCtx("tp"))).rejects.toThrow();
    await expect(tool.handler({ agent_name: "a" } as any, makeCtx("tp"))).rejects.toThrow();
  });

  it("emits status:item-update before runConversation and status:item-clear after", async () => {
    const reg = makeRegistryHandle(makeRegistry([m("a")]));
    const tracker = makeTurnTracker();
    tracker.onTurnStart({ turnId: "tp", trigger: "user" });
    const driver = { runConversation: async () => ({ finalMessage: { role: "assistant", content: "ok" }, messages: [], usage: { promptTokens: 0, completionTokens: 0 } }) };
    const tool = makeDispatchTool({ registry: reg, tracker, driver, maxDepth: 3, hasSkills: () => false });
    const ctx = makeCtx("tp");
    await tool.handler({ agent_name: "a", prompt: "p" }, ctx);
    const updateEvent = ctx.events.find((e: any) => e.event === "status:item-update");
    const clearEvent = ctx.events.find((e: any) => e.event === "status:item-clear");
    expect(updateEvent?.payload).toMatchObject({ key: "agents.active", value: "a" });
    expect(clearEvent?.payload).toMatchObject({ key: "agents.active" });
  });
});
