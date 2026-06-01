import { describe, it, expect } from "bun:test";
import { makeRunner } from "../runner.ts";
import { fakeDriver, eventBus } from "./_helpers.ts";

describe("runner", () => {
  it("static-parse failure short-circuits with MetaParseError; no workflow:start emitted", async () => {
    const bus = eventBus();
    const runner = makeRunner({
      driver: fakeDriver().driver,
      agentsRegistry: undefined,
      emit: (e, p) => bus.emit(e, p),
      runByName: async () => { throw new Error("not used"); },
      timeoutMs: 5000,
      gracefulShutdownMs: 100,
      maxConcurrency: 4,
      maxLifetimeAgents: 100,
      sessionIdProvider: () => "sess",
    });
    const r = await runner.runInline("// no meta here", {});
    expect(r.ok).toBe(false);
    expect(r.error?.name).toBe("MetaParseError");
    expect(bus.emitted.find((e) => e.name === "workflow:start")).toBeUndefined();
    expect(bus.emitted.find((e) => e.name === "workflow:end")).toBeDefined();
  });

  it("emits workflow:start and workflow:end with matching runId", async () => {
    const bus = eventBus();
    const runner = makeRunner({
      driver: fakeDriver().driver,
      agentsRegistry: undefined,
      emit: (e, p) => bus.emit(e, p),
      runByName: async () => { throw new Error("not used"); },
      timeoutMs: 5000,
      gracefulShutdownMs: 100,
      maxConcurrency: 4,
      maxLifetimeAgents: 100,
      sessionIdProvider: () => "sess",
    });
    const src = `export const meta = { name: "demo", description: "d" };\n`;
    const r = await runner.runInline(src, {});
    const startPayload = bus.emitted.find((e) => e.name === "workflow:start")?.payload as any;
    const endPayload = bus.emitted.find((e) => e.name === "workflow:end")?.payload as any;
    expect(startPayload?.runId).toBe(r.runId);
    expect(endPayload?.runId).toBe(r.runId);
    expect(endPayload?.ok).toBe(true);
  });
});
