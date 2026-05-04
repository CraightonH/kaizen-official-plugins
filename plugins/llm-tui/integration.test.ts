import { describe, it, expect, mock } from "bun:test";
import plugin from "./index.tsx";
import type { TuiCompletionService } from "./public.d.ts";

function makeCtx() {
  const provided: Record<string, unknown> = {};
  const subs: Record<string, Function[]> = {};
  const emitted: Array<{ event: string; payload?: unknown }> = [];
  return {
    provided,
    subs,
    emitted,
    log: mock(() => {}),
    config: {},
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

describe("llm-tui integration (non-TTY)", () => {
  it("public completion service registers and unregisters cleanly", async () => {
    const ctx = makeCtx();
    await plugin.setup(ctx);
    const cs = ctx.provided["llm-tui:completion"] as TuiCompletionService;
    const off = cs.register({
      id: "test", trigger: "/",
      list: () => [{ label: "/help", insertText: "/help " }],
    });
    expect(typeof off).toBe("function");
    off();
  });

  it("status:item-update + clear flow updates internal store without throwing", async () => {
    const ctx = makeCtx();
    await plugin.setup(ctx);
    const upd = ctx.subs["status:item-update"]![0]!;
    const clr = ctx.subs["status:item-clear"]![0]!;
    await upd({ key: "branch", value: "main" });
    await clr({ key: "branch" });
  });

  it("channel.writeOutput + writeNotice + setBusy + readInput respect the contract", async () => {
    const ctx = makeCtx();
    await plugin.setup(ctx);
    const ch = ctx.provided["llm-tui:channel"] as any;
    // Non-TTY path uses the fallback channel: writeOutput goes to stdout.
    // We just exercise the methods to verify they don't throw.
    ch.writeOutput("hi");
    ch.writeNotice("notice");
    ch.setBusy(true, "x");
    ch.setBusy(false);
    expect(typeof ch.readInput).toBe("function");
  });

  it("theme.current() reflects theme defaults", async () => {
    const ctx = makeCtx();
    await plugin.setup(ctx);
    const theme = (ctx.provided["llm-tui:theme"] as any).current();
    expect(theme.promptLabel).toBe("kaizen");
    expect(theme.outputColor).toBe("white");
  });
});
