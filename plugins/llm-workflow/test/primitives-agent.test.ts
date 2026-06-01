import { describe, it, expect } from "bun:test";
import { makeAgentCallback } from "../primitives/agent.ts";
import { makeSemaphore } from "../semaphore.ts";
import { makeBudget } from "../budget.ts";
import { fakeDriver, eventBus, counter } from "./_helpers.ts";
import type { AgentsRegistryService, AgentManifest } from "llm-contracts/public";

function makeAgentsRegistry(manifests: AgentManifest[]): AgentsRegistryService {
  const map = new Map(manifests.map((m) => [m.name, m]));
  return {
    list: () => [...map.values()],
    register: () => { throw new Error("not used in test"); },
  } as AgentsRegistryService;
}

describe("agent() host-side callback", () => {
  it("invokes driver and returns assistant text", async () => {
    const { driver, calls } = fakeDriver();
    const sem = makeSemaphore({ maxConcurrency: 4, maxLifetimeAgents: 100 });
    const budget = makeBudget({ total: null });
    const bus = eventBus();
    const cb = makeAgentCallback({
      runId: "r1",
      driver,
      agentsRegistry: undefined,
      semaphore: sem,
      budget,
      emit: (e, p) => bus.emit(e, p),
      sessionIdProvider: () => "sess",
      agentIdCounter: counter(),
    });
    const text = await cb({ prompt: "hello" });
    expect(text).toBe("ok:hello");
    expect(calls.length).toBe(1);
    expect(calls[0]!.systemPrompt).toBe("");
    expect(budget.spent()).toBe(5);
    expect(bus.emitted.map((e) => e.name)).toEqual(["workflow:agent-start", "workflow:agent-end"]);
  });

  it("overlays agentType from agents:registry when present", async () => {
    const { driver, calls } = fakeDriver();
    const reg = makeAgentsRegistry([{
      name: "reviewer",
      description: "code reviewer",
      systemPrompt: "You are a reviewer.",
      toolFilter: { names: ["read_file"] },
    }]);
    const cb = makeAgentCallback({
      runId: "r1",
      driver,
      agentsRegistry: reg,
      semaphore: makeSemaphore({ maxConcurrency: 4, maxLifetimeAgents: 100 }),
      budget: makeBudget({ total: null }),
      emit: () => {},
      sessionIdProvider: () => "sess",
      agentIdCounter: counter(),
    });
    await cb({ prompt: "review this", agentType: "reviewer" });
    expect(calls[0]!.systemPrompt).toBe("You are a reviewer.");
    expect(calls[0]!.toolFilter?.names).toEqual(["read_file"]);
  });

  it("throws if agentType is unknown", async () => {
    const cb = makeAgentCallback({
      runId: "r1",
      driver: fakeDriver().driver,
      agentsRegistry: makeAgentsRegistry([]),
      semaphore: makeSemaphore({ maxConcurrency: 4, maxLifetimeAgents: 100 }),
      budget: makeBudget({ total: null }),
      emit: () => {},
      sessionIdProvider: () => "sess",
      agentIdCounter: counter(),
    });
    await expect(cb({ prompt: "x", agentType: "missing" }))
      .rejects.toThrow(/unknown agentType/);
  });

  it("accumulates budget tokens from driver usage", async () => {
    const budget = makeBudget({ total: null });
    const cb = makeAgentCallback({
      runId: "r1",
      driver: fakeDriver({
        reply: async () => ({ finalMessage: { role: "assistant", content: "x" }, usage: { promptTokens: 1, completionTokens: 42 } }),
      }).driver,
      agentsRegistry: undefined,
      semaphore: makeSemaphore({ maxConcurrency: 4, maxLifetimeAgents: 100 }),
      budget,
      emit: () => {},
      sessionIdProvider: () => "sess",
      agentIdCounter: counter(),
    });
    await cb({ prompt: "x" });
    expect(budget.spent()).toBe(42);
  });
});
