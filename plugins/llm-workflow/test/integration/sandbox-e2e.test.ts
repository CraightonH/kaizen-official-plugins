import { describe, it, expect } from "bun:test";
import { makeRunner } from "../../runner.ts";
import { fakeDriver, eventBus } from "../_helpers.ts";

function mkRunner(args: { driver?: any } = {}) {
  const bus = eventBus();
  const driver = args.driver ?? fakeDriver({
    reply: async (input) => ({ finalMessage: { role: "assistant", content: `reply:${(input.userMessage as any)?.content ?? ""}` }, usage: { promptTokens: 1, completionTokens: 3 } }),
  }).driver;
  const runner = makeRunner({
    driver, agentsRegistry: undefined,
    emit: (e, p) => bus.emit(e, p),
    runByName: async () => { throw new Error("not used"); },
    timeoutMs: 8000, gracefulShutdownMs: 200,
    maxConcurrency: 4, maxLifetimeAgents: 100,
    sessionIdProvider: () => "sess",
  });
  return { runner, bus };
}

describe("sandbox end-to-end", () => {
  it("evaluates a script that calls agent() and returns a value", async () => {
    const { runner, bus } = mkRunner();
    const src = `
      export const meta = { name: "demo", description: "demo" };
      phase("Run");
      log("starting");
      const out = await agent("hello");
      return out;
    `;
    const r = await runner.runInline(src, {});
    expect(r.ok).toBe(true);
    expect(r.value).toBe("reply:hello");
    expect(bus.emitted.find((e) => e.name === "workflow:phase")?.payload).toMatchObject({ phase: "Run" });
    expect(bus.emitted.find((e) => e.name === "workflow:log")?.payload).toMatchObject({ message: "starting" });
    expect(r.agentCount).toBe(1);
  });

  it("parallel() runs two agent calls concurrently", async () => {
    const { runner } = mkRunner();
    const src = `
      export const meta = { name: "demo", description: "demo" };
      const results = await parallel([
        () => agent("a"),
        () => agent("b"),
      ]);
      return results;
    `;
    const r = await runner.runInline(src, {});
    expect(r.ok).toBe(true);
    expect((r.value as string[]).sort()).toEqual(["reply:a", "reply:b"]);
    expect(r.agentCount).toBe(2);
  });

  it("pipeline() chains stages per-item", async () => {
    const { runner } = mkRunner();
    const src = `
      export const meta = { name: "demo", description: "demo" };
      const out = await pipeline([1, 2],
        async (_p, item) => await agent("s1:" + item),
        async (prev) => await agent("s2:" + prev),
      );
      return out;
    `;
    const r = await runner.runInline(src, {});
    expect(r.ok).toBe(true);
    const out = r.value as string[];
    expect(out.length).toBe(2);
    expect(out[0]).toContain("reply:s2:reply:s1:1");
  });

  it("budget accumulates and is hard-capped", async () => {
    const driver = fakeDriver({
      reply: async () => ({ finalMessage: { role: "assistant", content: "x" }, usage: { promptTokens: 1, completionTokens: 50 } }),
    }).driver;
    const { runner } = mkRunner({ driver });
    const src = `
      export const meta = { name: "demo", description: "demo" };
      await agent("a");
      await agent("b");
      return await budget.spent();
    `;
    const r = await runner.runInline(src, { budgetTotal: 1000 });
    expect(r.ok).toBe(true);
    expect(r.value).toBe(100);
  });
});
