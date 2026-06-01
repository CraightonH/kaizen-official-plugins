import { describe, it, expect } from "bun:test";
import { makeRunner } from "../../runner.ts";
import { fakeDriver, eventBus } from "../_helpers.ts";

describe("sandbox cancellation", () => {
  it("external abort signal terminates the worker", async () => {
    const ac = new AbortController();
    const bus = eventBus();
    const runner = makeRunner({
      driver: fakeDriver({
        reply: async () => { await new Promise((r) => setTimeout(r, 500)); return { finalMessage: { role: "assistant", content: "late" }, usage: { promptTokens: 0, completionTokens: 0 } }; },
      }).driver,
      agentsRegistry: undefined,
      emit: (e, p) => bus.emit(e, p),
      runByName: async () => { throw new Error("not used"); },
      timeoutMs: 5000, gracefulShutdownMs: 200,
      maxConcurrency: 4, maxLifetimeAgents: 100,
      sessionIdProvider: () => "sess",
    });
    setTimeout(() => ac.abort(), 50);
    const r = await runner.runInline(`
      export const meta = { name: "demo", description: "demo" };
      await agent("slow");
      return "done";
    `, { signal: ac.signal });
    expect(r.ok).toBe(false);
    expect(r.error?.name).toBe("WorkflowAbortedError");
  });

  it("timeout terminates the worker", async () => {
    const bus = eventBus();
    const runner = makeRunner({
      driver: fakeDriver({
        reply: async () => { await new Promise((r) => setTimeout(r, 1000)); return { finalMessage: { role: "assistant", content: "late" }, usage: { promptTokens: 0, completionTokens: 0 } }; },
      }).driver,
      agentsRegistry: undefined,
      emit: (e, p) => bus.emit(e, p),
      runByName: async () => { throw new Error("not used"); },
      timeoutMs: 200, gracefulShutdownMs: 50,
      maxConcurrency: 4, maxLifetimeAgents: 100,
      sessionIdProvider: () => "sess",
    });
    const r = await runner.runInline(`
      export const meta = { name: "demo", description: "demo" };
      await agent("slow");
      return "done";
    `, {});
    expect(r.ok).toBe(false);
    expect(r.error?.name).toBe("WorkflowTimeoutError");
  });
});
