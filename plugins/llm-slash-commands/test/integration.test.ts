import { describe, it, expect, mock } from "bun:test";
import { join } from "node:path";
import plugin from "../index.ts";

const FIX = join(import.meta.dir, "fixtures");

function makeCtx(opts: { driver?: any; sessions?: any; tuiCompletion?: any } = {}) {
  const subs: Record<string, { fn: any; priority: number }[]> = {};
  const services: Record<string, unknown> = {};
  const emits: { event: string; payload: unknown }[] = [];
  const ctx: any = {
    log: () => {},
    config: {},
    signal: new AbortController().signal,
    defineService: mock(() => {}),
    provideService: mock((name: string, impl: unknown) => { services[name] = impl; }),
    useService: mock(<T,>(name: string): T | undefined => {
      if (name === "driver:run-conversation") return opts.driver as T | undefined;
      if (name === "sessions:store") {
        if (!opts.sessions) throw new Error(`useService: no provider for '${name}'`);
        return opts.sessions as T;
      }
      if (name === "ui:completion-source") {
        if (!opts.tuiCompletion) throw new Error(`useService: no provider for '${name}'`);
        return opts.tuiCompletion as T;
      }
      if (name === "config:store") return undefined;
      throw new Error(`useService: no provider for '${name}'`);
    }),
    on: mock((event: string, fn: any, o?: { priority?: number }) => {
      (subs[event] ??= []).push({ fn, priority: o?.priority ?? 0 });
    }),
    emit: mock(async (event: string, payload: unknown) => {
      emits.push({ event, payload });
      // Drive subscribers synchronously for test purposes.
      for (const s of (subs[event] ?? []).sort((a, b) => b.priority - a.priority)) {
        await s.fn(payload);
      }
    }),
  };
  return { ctx, services, emits, subs };
}

describe("llm-slash-commands integration", () => {
  it("setup loads built-ins, file commands, and provides slash:registry; project shadows user; reserved-name file warning surfaced", async () => {
    const origHome = process.env.HOME, origCwd = process.cwd();
    process.env.HOME = join(FIX, "user-home");
    process.chdir(join(FIX, "project-home"));

    const { ctx, services, emits } = makeCtx();
    await plugin.setup(ctx);

    // Service provided.
    expect((services["slash:registry"] as any).list().map((m: any) => m.name).sort()).toEqual(
      ["echo", "exit", "help", "history", "required-args"].sort(),
    );

    // Project shadowed user echo.
    const echo = (services["slash:registry"] as any).get("echo");
    expect(echo.manifest.description).toBe("Project echo");

    // Reserved-name (help.md) and bad-frontmatter file warnings surfaced as a system message.
    const sys = emits.find((e) => e.event === "conversation:system-message");
    expect(sys).toBeDefined();
    const text = (sys!.payload as any).message.content as string;
    expect(text).toMatch(/help\.md/);
    expect(text).toMatch(/bad-frontmatter\.md/);

    process.env.HOME = origHome;
    process.chdir(origCwd);
  });

  it("dispatches /echo via input:submit and calls runConversation for the active session", async () => {
    const origHome = process.env.HOME, origCwd = process.cwd();
    process.env.HOME = join(FIX, "user-home");
    process.chdir(join(FIX, "project-home"));

    const runConversation = mock(async () => ({ finalMessage: { role: "assistant", content: "" }, usage: { promptTokens: 0, completionTokens: 0 } }));
    const driver = { runConversation };
    const { ctx, emits } = makeCtx({ driver, sessions: {} });
    await plugin.setup(ctx);
    await ctx.emit("session:active-changed", { from: null, to: "session-1" });

    await ctx.emit("input:submit", { text: "/echo hello world" });

    const userMsg = emits.find((e) => e.event === "conversation:user-message");
    expect(userMsg).toBeUndefined();
    expect(runConversation).toHaveBeenCalledTimes(1);
    expect((runConversation.mock.calls as unknown as any[][])[0]![0]).toMatchObject({
      sessionId: "session-1",
      userMessage: { role: "user", content: "PROJECT:hello world\n" },
    });

    const handled = emits.find((e) => e.event === "input:handled");
    expect(handled?.payload).toEqual({ by: "llm-slash-commands" });

    process.env.HOME = origHome;
    process.chdir(origCwd);
  });

  it("required-args validation: empty args prints usage and does not run conversation", async () => {
    const origHome = process.env.HOME, origCwd = process.cwd();
    process.env.HOME = join(FIX, "user-home");
    process.chdir(join(FIX, "project-home"));

    const runConversation = mock(async () => ({} as any));
    const { ctx, emits } = makeCtx({ driver: { runConversation } });
    await plugin.setup(ctx);

    await ctx.emit("input:submit", { text: "/required-args" });

    expect(runConversation).not.toHaveBeenCalled();
    const sys = emits.filter((e) => e.event === "conversation:system-message").map((e: any) => e.payload.message.content).join("\n");
    expect(sys).toMatch(/requires arguments/);
    expect(sys).toMatch(/<text>/);

    process.env.HOME = origHome;
    process.chdir(origCwd);
  });

  it("registers a tui:completion source when present", async () => {
    const origHome = process.env.HOME, origCwd = process.cwd();
    process.env.HOME = join(FIX, "user-home");
    process.chdir(join(FIX, "project-home"));

    const tuiSources: any[] = [];
    const tui = { register: (s: any) => { tuiSources.push(s); return () => {}; } };
    const { ctx } = makeCtx({ tuiCompletion: tui });
    await plugin.setup(ctx);
    await ctx.emit("harness:start", {});

    expect(tuiSources.length).toBe(2);
    const commandSource = tuiSources.find((s: any) => s.trigger === "/");
    expect(commandSource).toBeDefined();
    const items = await commandSource!.list("he");
    expect(items.find((i: any) => i.label === "/help")).toBeDefined();

    process.env.HOME = origHome;
    process.chdir(origCwd);
  });

  it("registers an arg-completion source on harness:start", async () => {
    const origHome = process.env.HOME, origCwd = process.cwd();
    process.env.HOME = join(FIX, "user-home");
    process.chdir(join(FIX, "project-home"));

    const registered: any[] = [];
    const tui = { register: (s: any) => { registered.push(s); return () => {}; } };
    const { ctx } = makeCtx({ tuiCompletion: tui });
    await plugin.setup(ctx);
    await ctx.emit("harness:start", {});

    expect(registered.map((s: any) => s.id)).toContain("llm-slash-commands:args");

    process.env.HOME = origHome;
    process.chdir(origCwd);
  });
});
