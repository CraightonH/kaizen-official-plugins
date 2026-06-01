import { describe, it, expect } from "bun:test";
import { makeRunner } from "../../runner.ts";
import { fakeDriver, eventBus } from "../_helpers.ts";

function mkRunner() {
  const bus = eventBus();
  return {
    runner: makeRunner({
      driver: fakeDriver().driver, agentsRegistry: undefined,
      emit: (e, p) => bus.emit(e, p),
      runByName: async () => { throw new Error("not used"); },
      timeoutMs: 4000, gracefulShutdownMs: 200,
      maxConcurrency: 4, maxLifetimeAgents: 100,
      sessionIdProvider: () => "sess",
    }),
    bus,
  };
}

describe("sandbox determinism guards", () => {
  it("Date.now() throws inside the sandbox", async () => {
    const { runner } = mkRunner();
    const src = `
      export const meta = { name: "demo", description: "demo" };
      try { Date.now(); return "no-throw"; }
      catch (e) { return "ok:" + e.message; }
    `;
    const r = await runner.runInline(src, {});
    expect(r.ok).toBe(true);
    expect(String(r.value)).toContain("Date.now()");
  });

  it("Math.random() throws inside the sandbox", async () => {
    const { runner } = mkRunner();
    const src = `
      export const meta = { name: "demo", description: "demo" };
      try { Math.random(); return "no-throw"; }
      catch (e) { return "ok:" + e.message; }
    `;
    const r = await runner.runInline(src, {});
    expect(r.ok).toBe(true);
    expect(String(r.value)).toContain("Math.random()");
  });

  it("argless `new Date()` throws inside the sandbox", async () => {
    const { runner } = mkRunner();
    const src = `
      export const meta = { name: "demo", description: "demo" };
      try { new Date(); return "no-throw"; }
      catch (e) { return "ok:" + e.message; }
    `;
    const r = await runner.runInline(src, {});
    expect(r.ok).toBe(true);
    expect(String(r.value)).toContain("Date()");
  });
});
