import { describe, it, expect, mock } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../index.ts";

function makeCtx(opts: { tools?: any; driver?: any } = {}) {
  const subs: Record<string, ((p: any) => any)[]> = {};
  const provided: Record<string, unknown> = {};
  let registeredTool: any = null;
  let registeredHandler: any = null;
  return {
    subs, provided,
    get registeredTool() { return registeredTool; },
    get registeredHandler() { return registeredHandler; },
    log: () => {},
    config: {},
    defineEvent: () => {},
    on: (event: string, fn: any) => { (subs[event] ??= []).push(fn); },
    emit: async (event: string, payload: any) => { for (const f of subs[event] ?? []) await f(payload); },
    defineService: () => {},
    provideService: (name: string, impl: unknown) => { provided[name] = impl; },
    consumeService: () => {},
    useService: (name: string) => {
      if (name === "tools:registry") return {
        register: (s: any, h: any) => { registeredTool = s; registeredHandler = h; return () => {}; },
        list: () => [], invoke: async () => {},
      };
      if (name === "driver:run-conversation") return opts.driver;
      return undefined;
    },
    secrets: { get: async () => undefined, refresh: async () => undefined },
  } as any;
}

describe("llm-agents E2E", () => {
  it("discovers fixtures, lists agents, dispatches with manifest system prompt", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "llm-agents-e2e-"));
    const cfgPath = join(tmp, "config.json");
    const fixturesRoot = new URL("./fixtures", import.meta.url).pathname;
    await writeFile(cfgPath, JSON.stringify({
      maxDepth: 3,
      userDir: join(fixturesRoot, "agents-user"),
      projectDir: join(fixturesRoot, "agents-project"),
    }));
    process.env.KAIZEN_LLM_AGENTS_CONFIG = cfgPath;

    let captured: any = null;
    const driver = {
      runConversation: mock(async (input: any) => {
        captured = input;
        return { finalMessage: { role: "assistant", content: "DONE" }, messages: [], usage: { promptTokens: 1, completionTokens: 1 } };
      }),
    };
    const ctx = makeCtx({ driver });
    await plugin.setup(ctx);
    await new Promise((r) => setTimeout(r, 50));

    const reg: any = ctx.provided["agents:registry"];
    const names = reg.list().map((a: any) => a.name).sort();
    expect(names).toEqual(["code-reviewer", "doc-writer"]);

    // Simulate the parent turn so the tracker accepts the turnId.
    await ctx.emit("turn:start", { turnId: "t-parent", trigger: "user" });

    const handler = (ctx as any).registeredHandler;
    expect(handler).toBeTruthy();
    const result = await handler(
      { agent_name: "code-reviewer", prompt: "review file X" },
      { signal: new AbortController().signal, callId: "c1", turnId: "t-parent", log: () => {} },
    );
    expect(result).toBe("DONE");
    expect(captured.systemPrompt).toContain("careful, terse code reviewer");
    expect(captured.parentTurnId).toBe("t-parent");
    expect(captured.toolFilter.names).toContain("dispatch_agent");
    expect(captured.toolFilter.names).toContain("read_file");

    delete process.env.KAIZEN_LLM_AGENTS_CONFIG;
  });
});
