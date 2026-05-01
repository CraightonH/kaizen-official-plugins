import { describe, it, expect, mock } from "bun:test";
import { join } from "node:path";
import plugin from "../index.ts";

const FIX = join(import.meta.dir, "fixtures");

function makeCtx(opts: { driver?: any; tuiCompletion?: any } = {}) {
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
      if (name === "tui:completion") return opts.tuiCompletion as T | undefined;
      return undefined;
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
      ["echo", "exit", "help", "required-args"].sort(),
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

  it("dispatches /echo via input:submit, emits conversation:user-message and calls runConversation", async () => {
    const origHome = process.env.HOME, origCwd = process.cwd();
    process.env.HOME = join(FIX, "user-home");
    process.chdir(join(FIX, "project-home"));

    const runConversation = mock(async () => ({ finalMessage: { role: "assistant", content: "" }, messages: [], usage: { promptTokens: 0, completionTokens: 0 } }));
    const driver = { runConversation };
    const { ctx, emits } = makeCtx({ driver });
    await plugin.setup(ctx);

    await ctx.emit("input:submit", { text: "/echo hello world" });

    const userMsg = emits.find((e) => e.event === "conversation:user-message");
    expect(userMsg).toBeDefined();
    expect((userMsg!.payload as any).message.content).toBe("PROJECT:hello world\n");
    expect(runConversation).toHaveBeenCalledTimes(1);

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

    expect(tuiSources.length).toBe(1);
    expect(tuiSources[0]!.trigger).toBe("/");
    const items = await tuiSources[0]!.list("/he", 3);
    expect(items.find((i: any) => i.label === "/help")).toBeDefined();

    process.env.HOME = origHome;
    process.chdir(origCwd);
  });
});
