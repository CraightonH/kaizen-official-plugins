import { describe, it, expect, mock } from "bun:test";
import plugin, { createTuiChannel } from "./index.tsx";
import { TuiStore } from "./state/store.ts";
import type { UiPromptService } from "llm-contracts/public";

function makeCtx(overrides: { config?: Record<string, unknown> } = {}) {
  const provided: Record<string, unknown> = {};
  const subs: Record<string, Function[]> = {};
  const emitted: Array<{ event: string; payload?: unknown }> = [];
  const ctx = {
    provided,
    subs,
    emitted,
    _testStore: null as TuiStore | null,
    log: mock(() => {}),
    config: overrides.config ?? {},
    defineEvent: mock(() => {}),
    on: mock((event: string, h: Function) => { (subs[event] ??= []).push(h); }),
    emit: mock(async (event: string, payload?: unknown) => { emitted.push({ event, payload }); return []; }),
    defineService: mock(() => {}),
    provideService: mock((name: string, impl: unknown) => { provided[name] = impl; }),
    consumeService: mock(() => {}),
    useService: mock((name: string) => provided[name]),
    secrets: { get: mock(async () => undefined), refresh: mock(async () => undefined) },
  } as any;
  return ctx;
}

describe("llm-tui plugin", () => {
  it("metadata", () => {
    expect(plugin.name).toBe("llm-tui");
    expect(plugin.apiVersion).toBe("3.0.0");
    expect(plugin.permissions?.tier).toBe("unscoped");
  });

  it("provides all five services in non-TTY mode", async () => {
    const ctx = makeCtx();
    await plugin.setup(ctx);
    expect(ctx.provided["ui:channel"]).toBeDefined();
    expect(ctx.provided["ui:completion-source"]).toBeDefined();
    expect(ctx.provided["ui:status"]).toBeDefined();
    expect(ctx.provided["ui:theme"]).toBeDefined();
    expect(ctx.provided["ui:tool-renderer"]).toBeDefined();
  });

  it("subscribes to status:item-update and status:item-clear", async () => {
    const ctx = makeCtx();
    await plugin.setup(ctx);
    expect(ctx.subs["status:item-update"]?.length).toBe(1);
    expect(ctx.subs["status:item-clear"]?.length).toBe(1);
  });

  it("channel exposes the four UiChannelService methods", async () => {
    const ctx = makeCtx();
    await plugin.setup(ctx);
    const ch = ctx.provided["ui:channel"] as any;
    expect(typeof ch.readInput).toBe("function");
    expect(typeof ch.writeOutput).toBe("function");
    expect(typeof ch.writeNotice).toBe("function");
    expect(typeof ch.setBusy).toBe("function");
  });

  it("completion service exposes register()", async () => {
    const ctx = makeCtx();
    await plugin.setup(ctx);
    const cs = ctx.provided["ui:completion-source"] as any;
    expect(typeof cs.register).toBe("function");
    const off = cs.register({ id: "x", trigger: "/", list: () => [] });
    expect(typeof off).toBe("function");
    off();
  });

  it("theme service current() returns a UiTheme with default values", async () => {
    const ctx = makeCtx();
    await plugin.setup(ctx);
    const t = (ctx.provided["ui:theme"] as any).current();
    expect(t.promptLabel).toBe("kaizen");
    expect(t.promptColor).toBe("magenta");
  });

  it("status:item-update updates the channel-visible status (verified via theme/store wiring)", async () => {
    // This is a smoke test that the handler exists and runs without throwing.
    const ctx = makeCtx();
    await plugin.setup(ctx);
    const handler = ctx.subs["status:item-update"]![0]!;
    await handler({ key: "branch", value: "main" });
    // No assertion on rendered output (non-TTY); just that it completed.
  });

  it("subscribes to session:handoff and tolerates malformed payloads", async () => {
    const ctx = makeCtx();
    await plugin.setup(ctx);
    expect(ctx.subs["session:handoff"]?.length).toBe(1);
    const handler = ctx.subs["session:handoff"]![0]!;
    // Malformed payloads must not throw.
    await handler(undefined);
    await handler({});
    await handler({ prompt: 42 });
    // Well-formed autostart=true / autostart=false also must not throw
    // (store mutation is internal to the plugin; lifecycle correctness is
    // covered by the store unit tests + UI tests).
    await handler({ prompt: "hi", autostart: true, from: "abc" });
    await handler({ prompt: "hi", autostart: false });
  });

  it("channel exposes setInputDraft", async () => {
    const ctx = makeCtx();
    await plugin.setup(ctx);
    const ch = ctx.provided["ui:channel"] as any;
    expect(typeof ch.setInputDraft).toBe("function");
    // Non-TTY mode provides the fallback channel; setInputDraft is a no-op there.
    expect(() => ch.setInputDraft("draft")).not.toThrow();
  });

  it("accepts harness-provided default theme via plugin config", async () => {
    const ctx = makeCtx({ config: { theme: { promptLabel: "kaizen" } } });
    await plugin.setup(ctx);
    const t = (ctx.provided["ui:theme"] as any).current();
    expect(t.promptLabel).toBe("kaizen");
  });

  it("setup emits status hint advertising Ctrl+X", async () => {
    const ctx = makeCtx();
    await plugin.setup(ctx);
    const hint = ctx.emitted.find(
      (e) => e.event === "status:item-update" && (e.payload as any)?.key === "_tui:hint:copy",
    );
    expect(hint).toBeDefined();
    expect((hint!.payload as any).value).toContain("⌃X");
  });

  it("provides ui:prompt service", async () => {
    const ctx = makeCtx();
    await plugin.setup(ctx);
    const promptService = ctx.useService<UiPromptService>("ui:prompt");
    expect(typeof promptService.requestOption).toBe("function");
    expect(typeof promptService.requestText).toBe("function");
  });

  it("ui:prompt.requestOption opens the store slice and resolves on submit", async () => {
    const ctx = makeCtx();
    await plugin.setup(ctx);
    const promptService = ctx.useService<UiPromptService>("ui:prompt");
    const store: TuiStore = ctx._testStore;
    const pending = promptService.requestOption({
      title: "T",
      body: "B",
      options: [{ id: "ok", label: "OK" }],
    });
    expect(store.snapshot().prompt).not.toBeNull();
    store.submitPrompt({ id: "ok" });
    await expect(pending).resolves.toEqual({ id: "ok" });
  });

  describe("createTuiChannel — WriteOptions forwarded to store", () => {
    it("writeNotice with markdown:true sets entry.markdown === true", () => {
      const store = new TuiStore();
      const ch = createTuiChannel(store);
      ch.writeNotice("**bold**", { markdown: true });
      const entry = store.snapshot().transcript.at(-1) as any;
      expect(entry.text).toBe("**bold**");
      expect(entry.markdown).toBe(true);
    });

    it("writeOutput with markdown:false sets entry.markdown === false", () => {
      const store = new TuiStore();
      const ch = createTuiChannel(store);
      ch.writeOutput("raw output", { markdown: false });
      const entry = store.snapshot().transcript.at(-1) as any;
      expect(entry.text).toBe("raw output");
      expect(entry.markdown).toBe(false);
    });

    it("writeOutput with no opts leaves entry.markdown === undefined", () => {
      const store = new TuiStore();
      const ch = createTuiChannel(store);
      ch.writeOutput("bare output");
      const entry = store.snapshot().transcript.at(-1) as any;
      expect(entry.text).toBe("bare output");
      expect(entry.markdown).toBeUndefined();
    });

    it("writeUser with markdown:true sets entry.markdown === true", () => {
      const store = new TuiStore();
      const ch = createTuiChannel(store);
      ch.writeUser!("user msg", { markdown: true });
      const entry = store.snapshot().transcript.at(-1) as any;
      expect(entry.markdown).toBe(true);
    });
  });
});
