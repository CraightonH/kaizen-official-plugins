import { describe, it, expect, mock } from "bun:test";
import plugin from "./index.ts";

function makeCtx() {
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

describe("claude-tui", () => {
  it("has correct metadata", () => {
    expect(plugin.name).toBe("claude-tui");
    expect(plugin.apiVersion).toBe("3.0.0");
    expect(plugin.permissions?.tier).toBe("unscoped");
  });

  it("provides claude-tui:channel and subscribes to status events", async () => {
    const ctx = makeCtx();
    await plugin.setup(ctx);
    expect(ctx.provided["claude-tui:channel"]).toBeDefined();
    expect(ctx.subs["status:item-update"]?.length).toBe(1);
    expect(ctx.subs["status:item-clear"]?.length).toBe(1);
  });

  it("ui.writeOutput writes the chunk verbatim", async () => {
    const ctx = makeCtx();
    const writes: string[] = [];
    process.stdout.write = ((c: string) => { writes.push(String(c)); return true; }) as any;
    await plugin.setup(ctx);
    const ui = ctx.provided["claude-tui:channel"] as any;
    ui.writeOutput("hello");
    expect(writes.join("")).toContain("hello");
  });
});
