import { describe, it, expect, mock } from "bun:test";
import plugin from "./index.ts";

function makeCtx() {
  const defined: string[] = [];
  const provided: Record<string, unknown> = {};
  return {
    defined,
    provided,
    log: mock(() => {}),
    config: {},
    defineEvent: mock((name: string) => { defined.push(name); }),
    on: mock(() => {}),
    emit: mock(async () => []),
    defineService: mock(() => {}),
    provideService: mock((name: string, impl: unknown) => { provided[name] = impl; }),
    consumeService: mock(() => {}),
    useService: mock(() => undefined),
    secrets: { get: mock(async () => undefined), refresh: mock(async () => undefined) },
  } as any;
}

describe("claude-events", () => {
  it("has correct metadata", () => {
    expect(plugin.name).toBe("claude-events");
    expect(plugin.apiVersion).toBe("3.0.0");
  });

  it("provides claude-events:vocabulary", async () => {
    const ctx = makeCtx();
    await plugin.setup(ctx);
    expect(ctx.provided["claude-events:vocabulary"]).toBeDefined();
    const vocab = ctx.provided["claude-events:vocabulary"] as Record<string, string>;
    expect(vocab.SESSION_START).toBe("session:start");
    expect(vocab.TURN_CANCEL).toBe("turn:cancel");
    expect(vocab.STATUS_ITEM_UPDATE).toBe("status:item-update");
  });

  it("defines all 8 event names", async () => {
    const ctx = makeCtx();
    await plugin.setup(ctx);
    expect(ctx.defined).toEqual([
      "session:start", "session:end", "session:error",
      "turn:before", "turn:after", "turn:cancel",
      "status:item-update", "status:item-clear",
    ]);
  });
});
