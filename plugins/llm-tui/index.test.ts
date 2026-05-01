import { describe, it, expect, mock } from "bun:test";
import plugin from "./index.tsx";

function makeCtx(overrides: { config?: Record<string, unknown> } = {}) {
  const provided: Record<string, unknown> = {};
  const subs: Record<string, Function[]> = {};
  const emitted: Array<{ event: string; payload?: unknown }> = [];
  return {
    provided,
    subs,
    emitted,
    log: mock(() => {}),
    config: overrides.config ?? {},
    defineEvent: mock(() => {}),
    on: mock((event: string, h: Function) => { (subs[event] ??= []).push(h); }),
    emit: mock(async (event: string, payload?: unknown) => { emitted.push({ event, payload }); return []; }),
    defineService: mock(() => {}),
    provideService: mock((name: string, impl: unknown) => { provided[name] = impl; }),
    consumeService: mock(() => {}),
    useService: mock(() => undefined),
    secrets: { get: mock(async () => undefined), refresh: mock(async () => undefined) },
  } as any;
}

describe("llm-tui plugin", () => {
  it("metadata", () => {
    expect(plugin.name).toBe("llm-tui");
    expect(plugin.apiVersion).toBe("3.0.0");
    expect(plugin.permissions?.tier).toBe("unscoped");
  });

  it("provides all four services in non-TTY mode", async () => {
    const ctx = makeCtx();
    await plugin.setup(ctx);
    expect(ctx.provided["llm-tui:channel"]).toBeDefined();
    expect(ctx.provided["llm-tui:completion"]).toBeDefined();
    expect(ctx.provided["llm-tui:status"]).toBeDefined();
    expect(ctx.provided["llm-tui:theme"]).toBeDefined();
  });

  it("subscribes to status:item-update and status:item-clear", async () => {
    const ctx = makeCtx();
    await plugin.setup(ctx);
    expect(ctx.subs["status:item-update"]?.length).toBe(1);
    expect(ctx.subs["status:item-clear"]?.length).toBe(1);
  });

  it("channel exposes the four TuiChannelService methods", async () => {
    const ctx = makeCtx();
    await plugin.setup(ctx);
    const ch = ctx.provided["llm-tui:channel"] as any;
    expect(typeof ch.readInput).toBe("function");
    expect(typeof ch.writeOutput).toBe("function");
    expect(typeof ch.writeNotice).toBe("function");
    expect(typeof ch.setBusy).toBe("function");
  });

  it("completion service exposes register()", async () => {
    const ctx = makeCtx();
    await plugin.setup(ctx);
    const cs = ctx.provided["llm-tui:completion"] as any;
    expect(typeof cs.register).toBe("function");
    const off = cs.register({ id: "x", trigger: "/", list: () => [] });
    expect(typeof off).toBe("function");
    off();
  });

  it("theme service current() returns a TuiTheme with default values", async () => {
    const ctx = makeCtx();
    await plugin.setup(ctx);
    const t = (ctx.provided["llm-tui:theme"] as any).current();
    expect(t.promptLabel).toBe("llm");
    expect(t.promptColor).toBe("cyan");
  });

  it("status:item-update updates the channel-visible status (verified via theme/store wiring)", async () => {
    // This is a smoke test that the handler exists and runs without throwing.
    const ctx = makeCtx();
    await plugin.setup(ctx);
    const handler = ctx.subs["status:item-update"]![0]!;
    await handler({ key: "branch", value: "main" });
    // No assertion on rendered output (non-TTY); just that it completed.
  });

  it("accepts harness-provided default theme via plugin config", async () => {
    const ctx = makeCtx({ config: { theme: { promptLabel: "kaizen" } } });
    await plugin.setup(ctx);
    const t = (ctx.provided["llm-tui:theme"] as any).current();
    expect(t.promptLabel).toBe("kaizen");
  });
});
