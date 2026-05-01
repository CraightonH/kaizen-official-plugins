import { describe, it, expect, mock } from "bun:test";
import plugin from "../index.ts";

function makeCtx() {
  const provided: Record<string, unknown> = {};
  return {
    log: mock(() => {}),
    config: {},
    defineEvent: mock(() => {}),
    on: mock(() => {}),
    emit: mock(async () => []),
    defineService: mock(() => {}),
    provideService: mock((name: string, impl: unknown) => { provided[name] = impl; }),
    consumeService: mock(() => {}),
    useService: mock(() => undefined),
    secrets: { get: mock(async () => undefined), refresh: mock(async () => undefined) },
    provided,
  } as any;
}

describe("llm-codemode-dispatch plugin", () => {
  it("metadata", () => {
    expect(plugin.name).toBe("llm-codemode-dispatch");
    expect(plugin.apiVersion).toBe("3.0.0");
    expect(plugin.permissions?.tier).toBe("unscoped");
    expect(plugin.services?.provides).toEqual(["tool-dispatch:strategy"]);
  });

  it("provides tool-dispatch:strategy on setup", async () => {
    const ctx = makeCtx();
    await plugin.setup(ctx);
    const svc = ctx.provided["tool-dispatch:strategy"] as any;
    expect(typeof svc.prepareRequest).toBe("function");
    expect(typeof svc.handleResponse).toBe("function");
  });
});
