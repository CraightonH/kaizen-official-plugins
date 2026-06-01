import { describe, it, expect } from "bun:test";
import plugin from "../index.ts";

describe("plugin manifest", () => {
  it("declares apiVersion 3.0.0, tier unscoped, provides workflow:registry", () => {
    expect(plugin.apiVersion).toBe("3.0.0");
    expect(plugin.permissions?.tier).toBe("unscoped");
    expect(plugin.services?.provides).toContain("workflow:registry");
    expect(plugin.services?.consumes).toContain("events:vocabulary");
    expect(plugin.services?.consumes).toContain("driver:run-conversation");
    expect(plugin.services?.consumes).toContain("tools:registry");
    expect(plugin.services?.consumes).toContain("slash:registry");
  });

  it("setup is idempotent — calling stop after setup completes without throwing", async () => {
    const ctx: any = makeFakeCtx();
    await plugin.setup!(ctx);
    await plugin.stop!();
    // second cycle
    await plugin.setup!(ctx);
    await plugin.stop!();
  });
});

function makeFakeCtx() {
  return {
    log: (_m: string) => {},
    emit: async (_e: string, _p: unknown) => {},
    on: (_e: string, _fn: (p: unknown) => void) => {},
    defineEvent: (_n: string) => {},
    defineService: (_n: string, _meta: any) => {},
    provideService: <T>(_n: string, _impl: T) => {},
    useService: <T>(_n: string): T | undefined => undefined,
    consumeService: (_n: string) => {},
  };
}
