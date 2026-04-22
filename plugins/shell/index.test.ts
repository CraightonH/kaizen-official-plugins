import { describe, it, expect, mock } from "bun:test";
import plugin from "./index.ts";

function makeCtx() {
  return {
    log: mock(() => {}),
    config: {},
    on: mock(() => {}),
    defineEvent: mock(() => {}),
    emit: mock(async () => []),
    secrets: {
      get: mock(async (_key: string): Promise<string | undefined> => undefined),
      refresh: mock(async (_key: string): Promise<string | undefined> => undefined),
    },
    defineService: mock(() => {}),
    provideService: mock(() => {}),
    consumeService: mock(() => {}),
    useService: mock(() => undefined),
  } as any;
}

describe("shell", () => {
  it("has correct metadata", () => {
    expect(plugin.name).toBe("shell");
    expect(plugin.apiVersion).toBe("2.0.0");
  });

  it("setup runs without error", async () => {
    const ctx = makeCtx();
    await plugin.setup(ctx);
    expect(ctx.log).toHaveBeenCalled();
  });
});
