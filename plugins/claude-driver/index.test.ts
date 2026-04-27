import { describe, it, expect, mock } from "bun:test";
import plugin from "./index.ts";

function makeCtx() {
  return {
    log: mock(() => {}),
    config: {},
    defineEvent: mock(() => {}),
    on: mock(() => {}),
    emit: mock(async () => []),
    defineService: mock(() => {}),
    provideService: mock(() => {}),
    consumeService: mock(() => {}),
    useService: mock(() => undefined),
    secrets: { get: mock(async () => undefined), refresh: mock(async () => undefined) },
  } as any;
}

describe("claude-driver", () => {
  it("has correct metadata", () => {
    expect(plugin.name).toBe("claude-driver");
    expect(plugin.apiVersion).toBe("3.0.0");
    expect(plugin.driver).toBe(true);
    expect(plugin.permissions?.tier).toBe("unscoped");
  });

  it("setup declares consumes for events vocab and ui:channel", async () => {
    const ctx = makeCtx();
    await plugin.setup(ctx);
    expect(ctx.consumeService).toHaveBeenCalledWith("claude-events:vocabulary");
    expect(ctx.consumeService).toHaveBeenCalledWith("ui:channel");
  });
});
