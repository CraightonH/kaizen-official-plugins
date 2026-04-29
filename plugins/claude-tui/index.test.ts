import { describe, it, expect, mock } from "bun:test";
import plugin from "./index.tsx";

function makeCtx(opts?: { isTTY?: boolean }) {
  const provided: Record<string, unknown> = {};
  const subs: Record<string, Function[]> = {};
  return {
    provided,
    subs,
    log: mock(() => {}),
    config: {},
    defineEvent: mock(() => {}),
    on: mock((event: string, h: Function) => {
      (subs[event] ??= []).push(h);
    }),
    emit: mock(async () => []),
    defineService: mock(() => {}),
    provideService: mock((name: string, impl: unknown) => { provided[name] = impl; }),
    consumeService: mock(() => {}),
    useService: mock(() => undefined),
    secrets: { get: mock(async () => undefined), refresh: mock(async () => undefined) },
  } as any;
}

describe("claude-tui plugin (non-TTY mode)", () => {
  // Tests run in `bun test` — stdin/stdout are not TTYs, so the plugin
  // takes the fallback path. This keeps the test deterministic without
  // mounting Ink during unit tests.

  it("has correct metadata", () => {
    expect(plugin.name).toBe("claude-tui");
    expect(plugin.apiVersion).toBe("3.0.0");
    expect(plugin.permissions?.tier).toBe("unscoped");
  });

  it("provides claude-tui:channel and registers status handlers", async () => {
    const ctx = makeCtx();
    await plugin.setup(ctx);
    expect(ctx.provided["claude-tui:channel"]).toBeDefined();
    expect(ctx.subs["status:item-update"]?.length).toBe(1);
    expect(ctx.subs["status:item-clear"]?.length).toBe(1);
  });

  it("channel exposes UiChannel methods", async () => {
    const ctx = makeCtx();
    await plugin.setup(ctx);
    const ui = ctx.provided["claude-tui:channel"] as any;
    expect(typeof ui.readInput).toBe("function");
    expect(typeof ui.writeOutput).toBe("function");
    expect(typeof ui.writeNotice).toBe("function");
    expect(typeof ui.setBusy).toBe("function");
  });
});
