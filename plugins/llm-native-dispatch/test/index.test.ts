// plugins/llm-native-dispatch/test/index.test.ts
import { describe, it, expect, mock } from "bun:test";
import plugin from "../index.ts";
import type { ToolDispatchStrategy } from "../strategy.ts";

function makeCtx() {
  const provided: Record<string, unknown> = {};
  return {
    provided,
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
  } as any;
}

describe("llm-native-dispatch plugin", () => {
  it("metadata", () => {
    expect(plugin.name).toBe("llm-native-dispatch");
    expect(plugin.apiVersion).toBe("3.0.0");
    expect(plugin.permissions).toEqual({ tier: "trusted" });
    expect(plugin.services?.provides).toContain("tool-dispatch:strategy");
    expect(plugin.services?.consumes).toContain("tools:registry");
    expect(plugin.services?.consumes).toContain("llm-events:vocabulary");
  });

  it("setup defines and provides tool-dispatch:strategy", async () => {
    const ctx = makeCtx();
    await plugin.setup(ctx);
    expect(ctx.defineService).toHaveBeenCalledWith("tool-dispatch:strategy", expect.objectContaining({ description: expect.any(String) }));
    const svc = ctx.provided["tool-dispatch:strategy"] as ToolDispatchStrategy;
    expect(svc).toBeDefined();
    expect(typeof svc.prepareRequest).toBe("function");
    expect(typeof svc.handleResponse).toBe("function");
  });
});
