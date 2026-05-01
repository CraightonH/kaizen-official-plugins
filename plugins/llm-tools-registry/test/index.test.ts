import { describe, it, expect, mock } from "bun:test";
import plugin from "../index.ts";
import type { ToolsRegistryService } from "../registry.ts";

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

describe("llm-tools-registry plugin", () => {
  it("metadata", () => {
    expect(plugin.name).toBe("llm-tools-registry");
    expect(plugin.apiVersion).toBe("3.0.0");
    expect(plugin.permissions).toEqual({ tier: "trusted" });
    expect(plugin.services?.provides).toContain("tools:registry");
    expect(plugin.services?.consumes).toContain("llm-events:vocabulary");
  });

  it("setup defines and provides tools:registry with the registry instance", async () => {
    const ctx = makeCtx();
    await plugin.setup(ctx);
    expect(ctx.defineService).toHaveBeenCalledWith("tools:registry", expect.objectContaining({ description: expect.any(String) }));
    const svc = ctx.provided["tools:registry"] as ToolsRegistryService;
    expect(svc).toBeDefined();
    expect(typeof svc.register).toBe("function");
    expect(typeof svc.list).toBe("function");
    expect(typeof svc.invoke).toBe("function");
  });

  it("invoking a registered tool routes events through ctx.emit", async () => {
    const ctx = makeCtx();
    await plugin.setup(ctx);
    const svc = ctx.provided["tools:registry"] as ToolsRegistryService;
    svc.register(
      { name: "noop", description: "", parameters: { type: "object" } as any },
      async () => "done",
    );
    await svc.invoke("noop", {}, { signal: new AbortController().signal, callId: "c1", log: () => {} });
    const names = (ctx.emit as any).mock.calls.map((c: any[]) => c[0]);
    expect(names).toEqual(["tool:before-execute", "tool:execute", "tool:result"]);
  });
});
