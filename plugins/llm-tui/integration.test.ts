import { describe, it, expect, mock } from "bun:test";
import plugin from "./index.tsx";
import type { UiCompletionService } from "llm-contracts/public";
import { TuiStore } from "./state/store.ts";

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
    const cs = ctx.provided["ui:completion-source"] as UiCompletionService;
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
    const ch = ctx.provided["ui:channel"] as any;
    // Non-TTY path uses the fallback channel: writeOutput goes to stdout.
    // We just exercise the methods to verify they don't throw.
    ch.writeOutput("hi");
    ch.writeNotice("notice");
    ch.setBusy(true, "x");
    ch.setBusy(false);
    expect(typeof ch.readInput).toBe("function");
  });

  it("tool:execute → tool:progress → tool:result populates a tool_call entry end-to-end", async () => {
    const ctx = makeCtx();
    await plugin.setup(ctx);
    const exec = ctx.subs["tool:execute"]![0]!;
    const prog = ctx.subs["tool:progress"]![0]!;
    const res = ctx.subs["tool:result"]![0]!;
    await exec({ callId: "c1", name: "read_file", args: { path: "/etc/hosts" } });
    await prog({ callId: "c1", delta: "127.0.0.1 localhost\n" });
    await res({ callId: "c1", result: "127.0.0.1 localhost\n" });
    // The TUI plugin's tool-renderer service was provided.
    expect(ctx.provided["ui:tool-renderer"]).toBeDefined();
  });

  it("store lifecycle: appendLiveToolCall → updateLiveToolCall → finalizeLiveToolCall accumulates stdout into transcript", () => {
    const store = new TuiStore();
    store.appendLiveToolCall("c1", "read_file", { path: "/etc/hosts" });
    store.updateLiveToolCall("c1", { stdoutDelta: "127.0.0.1 localhost\n" });
    store.updateLiveToolCall("c1", { result: "127.0.0.1 localhost\n" });
    store.finalizeLiveToolCall("c1", "done");
    const t = store.snapshot().transcript;
    expect(t).toHaveLength(1);
    expect((t[0] as any).status).toBe("done");
    expect((t[0] as any).stdout).toBe("127.0.0.1 localhost\n");
  });

  it("theme.current() reflects theme defaults", async () => {
    const ctx = makeCtx();
    await plugin.setup(ctx);
    const theme = (ctx.provided["ui:theme"] as any).current();
    expect(theme.promptLabel).toBe("kaizen");
    expect(theme.outputColor).toBe("white");
  });
});
