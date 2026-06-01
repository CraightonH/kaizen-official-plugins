import { describe, it, expect } from "bun:test";
import { makeEngine } from "../engine.ts";
import { makeRegistry, makeRegistryHandle } from "../registry.ts";
import { makeRunner } from "../runner.ts";
import { fakeDriver, eventBus } from "./_helpers.ts";
import { WorkflowNotFoundError, WorkflowRegistryLoadingError } from "../errors.ts";

function makeEngineFixture() {
  const bus = eventBus();
  const reg = makeRegistryHandle(makeRegistry([
    { meta: { name: "hello", description: "hi" }, source: `export const meta = { name: "hello", description: "hi" };\n`, scope: "user" },
  ]));
  const driver = fakeDriver().driver;
  let ready = true;
  const isReady = () => ready;
  const setReady = (v: boolean) => { ready = v; };
  const runner = makeRunner({
    driver, agentsRegistry: undefined,
    emit: (e, p) => bus.emit(e, p),
    runByName: async (n, opts) => engine.runByName(n, opts),
    timeoutMs: 5000, gracefulShutdownMs: 100,
    maxConcurrency: 4, maxLifetimeAgents: 100,
    sessionIdProvider: () => "sess",
  });
  const engine: any = makeEngine({ registry: reg, runner, isReady });
  return { engine, bus, setReady };
}

describe("engine", () => {
  it("list/get delegates to registry handle", () => {
    const { engine } = makeEngineFixture();
    expect(engine.list().map((m: any) => m.meta.name)).toEqual(["hello"]);
    expect(engine.get("hello")?.meta.name).toBe("hello");
    expect(engine.get("nope")).toBeUndefined();
  });

  it("runByName fails with WorkflowNotFoundError for unknown name", async () => {
    const { engine } = makeEngineFixture();
    const r = await engine.runByName("missing");
    expect(r.ok).toBe(false);
    expect(r.error?.name).toBe("WorkflowNotFoundError");
  });

  it("runByName fails with WorkflowRegistryLoadingError while not ready", async () => {
    const { engine, setReady } = makeEngineFixture();
    setReady(false);
    const r = await engine.runByName("hello");
    expect(r.error?.name).toBe("WorkflowRegistryLoadingError");
  });
});
