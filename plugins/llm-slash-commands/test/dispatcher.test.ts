import { describe, it, expect, mock } from "bun:test";
import { createRegistry } from "../registry.ts";
import { registerBuiltins } from "../builtins.ts";
import { makeOnInputSubmit } from "../dispatcher.ts";
import { ReentrantSlashEmitError } from "../errors.ts";

function makeBus() {
  const emitted: { event: string; payload: unknown }[] = [];
  return {
    emitted,
    emit: mock(async (event: string, payload: unknown) => { emitted.push({ event, payload }); }),
    signal: new AbortController().signal,
  };
}

describe("makeOnInputSubmit", () => {
  it("non-slash input: no-op (no input:handled)", async () => {
    const reg = createRegistry(); registerBuiltins(reg);
    const bus = makeBus();
    const fn = makeOnInputSubmit({ registry: reg, bus });
    await fn({ text: "hello" });
    expect(bus.emitted).toEqual([]);
  });

  it("matched /help: calls handler and emits input:handled", async () => {
    const reg = createRegistry(); registerBuiltins(reg);
    const bus = makeBus();
    const fn = makeOnInputSubmit({ registry: reg, bus });
    await fn({ text: "/help" });
    const handled = bus.emitted.find((e) => e.event === "input:handled");
    expect(handled?.payload).toEqual({ by: "llm-slash-commands" });
  });

  it("unknown command: prints system message and emits input:handled", async () => {
    const reg = createRegistry(); registerBuiltins(reg);
    const bus = makeBus();
    const fn = makeOnInputSubmit({ registry: reg, bus });
    await fn({ text: "/nope" });
    const sys = bus.emitted.find((e) => e.event === "conversation:system-message");
    expect(sys).toBeDefined();
    expect((sys!.payload as any).message.content).toMatch(/Unknown command: \/nope/);
    expect(bus.emitted.find((e) => e.event === "input:handled")).toBeDefined();
  });

  it("handler throwing: surfaces session:error AND still emits input:handled", async () => {
    const reg = createRegistry();
    reg.register({ name: "boom", description: "d", source: "builtin" }, async () => { throw new Error("kapow"); });
    const bus = makeBus();
    const fn = makeOnInputSubmit({ registry: reg, bus });
    await fn({ text: "/boom" });
    const err = bus.emitted.find((e) => e.event === "session:error");
    expect(err).toBeDefined();
    expect((err!.payload as any).message).toMatch(/kapow/);
    expect(bus.emitted.find((e) => e.event === "input:handled")).toBeDefined();
  });

  it("handler that emits input:submit: wrapped emit throws ReentrantSlashEmitError surfaced via session:error", async () => {
    const reg = createRegistry();
    reg.register({ name: "loopy", description: "d", source: "builtin" }, async (ctx) => {
      await ctx.emit("input:submit", { text: "/help" });
    });
    const bus = makeBus();
    const fn = makeOnInputSubmit({ registry: reg, bus });
    await fn({ text: "/loopy" });
    const err = bus.emitted.find((e) => e.event === "session:error") as any;
    expect(err).toBeDefined();
    expect(String(err.payload.message)).toMatch(/input:submit/);
    expect(bus.emitted.find((e) => e.event === "input:handled")).toBeDefined();
  });

  it("re-entry guard: invoking the subscriber while inSlashDispatch is set returns immediately", async () => {
    const reg = createRegistry();
    let inner: any = null;
    reg.register({ name: "outer", description: "d", source: "builtin" }, async () => {
      // Simulate a sneaky re-entry: invoke the subscriber directly during dispatch.
      await inner!({ text: "/help" });
    });
    registerBuiltins(reg);
    const bus = makeBus();
    inner = makeOnInputSubmit({ registry: reg, bus });
    await inner({ text: "/outer" });
    // Only one input:handled (from outer) — the inner /help call was ignored.
    const handled = bus.emitted.filter((e) => e.event === "input:handled");
    expect(handled.length).toBe(1);
  });

  it("ctx.print emits conversation:system-message with role:system", async () => {
    const reg = createRegistry();
    reg.register({ name: "say", description: "d", source: "builtin" }, async (ctx) => {
      await ctx.print("hello world");
    });
    const bus = makeBus();
    const fn = makeOnInputSubmit({ registry: reg, bus });
    await fn({ text: "/say" });
    const sys = bus.emitted.find((e) => e.event === "conversation:system-message") as any;
    expect(sys).toBeDefined();
    expect(sys.payload.message.role).toBe("system");
    expect(sys.payload.message.content).toBe("hello world");
  });
});
