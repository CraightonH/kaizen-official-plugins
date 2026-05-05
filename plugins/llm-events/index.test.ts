import { describe, it, expect, mock } from "bun:test";
import plugin, { VOCAB } from "./index.ts";
import { CANCEL_TOOL } from "./index.ts";

function makeCtx() {
  const defined: string[] = [];
  const provided: Record<string, unknown> = {};
  return {
    defined,
    provided,
    log: mock(() => {}),
    config: {},
    defineEvent: mock((name: string) => { defined.push(name); }),
    on: mock(() => {}),
    emit: mock(async () => []),
    defineService: mock(() => {}),
    provideService: mock((name: string, impl: unknown) => { provided[name] = impl; }),
    consumeService: mock(() => {}),
    useService: mock(() => undefined),
    secrets: { get: mock(async () => undefined), refresh: mock(async () => undefined) },
  } as any;
}

describe("llm-events", () => {
  it("metadata", () => {
    expect(plugin.name).toBe("llm-events");
    expect(plugin.apiVersion).toBe("3.0.0");
  });

  it("VOCAB is frozen", () => {
    expect(Object.isFrozen(VOCAB)).toBe(true);
  });

  it("VOCAB exposes the Spec 0 event names", () => {
    expect(VOCAB.SESSION_START).toBe("session:start");
    expect(VOCAB.LLM_BEFORE_CALL).toBe("llm:before-call");
    expect(VOCAB.LLM_TOKEN).toBe("llm:token");
    expect(VOCAB.LLM_DONE).toBe("llm:done");
    expect(VOCAB.LLM_ERROR).toBe("llm:error");
    expect(VOCAB.TOOL_BEFORE_EXECUTE).toBe("tool:before-execute");
    expect(VOCAB.TURN_START).toBe("turn:start");
  });

  it("CANCEL_TOOL is the well-known symbol", () => {
    expect(CANCEL_TOOL).toBe(Symbol.for("kaizen.cancel"));
  });

  it("VOCAB contains every Spec 0 event name", () => {
    const expected = new Set([
      "session:start",
      "session:end",
      "session:error",
      "session:exit-requested",
      "input:submit",
      "input:handled",
      "conversation:user-message",
      "conversation:assistant-message",
      "conversation:system-message",
      "conversation:cleared",
      "turn:start",
      "turn:end",
      "turn:cancel",
      "turn:error",
      "llm:before-call",
      "llm:request",
      "llm:token",
      "llm:reasoning",
      "llm:tool-call",
      "llm:done",
      "llm:error",
      "tool:before-execute",
      "tool:execute",
      "tool:result",
      "tool:error",
      "codemode:code-emitted",
      "codemode:before-execute",
      "codemode:result",
      "codemode:error",
      "skill:loaded",
      "skill:available-changed",
      "status:item-update",
      "status:item-clear",
    ]);
    const actual = new Set(Object.values(VOCAB));
    for (const name of expected) expect(actual.has(name)).toBe(true);
    for (const name of actual) expect(expected.has(name as string)).toBe(true);
    expect(actual.size).toBe(expected.size);
  });

  it("re-exports tools:registry interface types", async () => {
    type _Probe = import("./public").ToolsRegistryService extends {
      register: (...a: any[]) => any;
      list: (...a: any[]) => any;
      invoke: (...a: any[]) => any;
    } ? true : false;
    const ok: _Probe = true;
    expect(ok).toBe(true);

    type _Ctx = import("./public").ToolExecutionContext extends {
      signal: AbortSignal;
      callId: string;
      log: (msg: string) => void;
    } ? true : false;
    const ctxOk: _Ctx = true;
    expect(ctxOk).toBe(true);

    type _Handler = import("./public").ToolHandler extends
      (args: unknown, ctx: any) => Promise<unknown> ? true : false;
    const handlerOk: _Handler = true;
    expect(handlerOk).toBe(true);
  });

  it("re-exports tool-dispatch:strategy interface type", () => {
    type _Strat = import("./public").ToolDispatchStrategy extends {
      prepareRequest: (...a: any[]) => any;
      handleResponse: (...a: any[]) => Promise<any>;
    } ? true : false;
    const ok: _Strat = true;
    expect(ok).toBe(true);
  });

  it("re-exports driver:run-conversation interface types", () => {
    type _Driver = import("./public").DriverService extends {
      runConversation: (...a: any[]) => Promise<any>;
    } ? true : false;
    const ok: _Driver = true;
    expect(ok).toBe(true);

    type _In = import("./public").RunConversationInput extends {
      systemPrompt: string;
      messages: any[];
    } ? true : false;
    const inOk: _In = true;
    expect(inOk).toBe(true);

    type _Out = import("./public").RunConversationOutput extends {
      finalMessage: any;
      messages: any[];
      usage: { promptTokens: number; completionTokens: number };
    } ? true : false;
    const outOk: _Out = true;
    expect(outOk).toBe(true);
  });

  it("re-exports skills:registry interface types", () => {
    type _Reg = import("./public").SkillsRegistryService extends {
      list: () => any;
      load: (name: string) => Promise<string>;
      register: (...a: any[]) => () => void;
      rescan: () => Promise<void>;
    } ? true : false;
    const ok: _Reg = true;
    expect(ok).toBe(true);

    type _Manifest = import("./public").SkillManifest extends {
      name: string;
      description: string;
    } ? true : false;
    const mOk: _Manifest = true;
    expect(mOk).toBe(true);
  });

  it("re-exports agents:registry interface types", () => {
    type _Reg = import("./public").AgentsRegistryService extends {
      list: () => any;
      register: (...a: any[]) => () => void;
    } ? true : false;
    const ok: _Reg = true;
    expect(ok).toBe(true);

    type _Manifest = import("./public").AgentManifest extends {
      name: string;
      description: string;
      systemPrompt: string;
    } ? true : false;
    const mOk: _Manifest = true;
    expect(mOk).toBe(true);
  });

  it("re-exports slash:registry interface types", () => {
    type _Reg = import("./public").SlashRegistryService extends {
      register: (...a: any[]) => () => void;
      list: () => any;
      tryDispatch: (...a: any[]) => Promise<boolean>;
    } ? true : false;
    const ok: _Reg = true;
    expect(ok).toBe(true);

    type _Manifest = import("./public").SlashCommandManifest extends {
      name: string;
      description: string;
      source: "builtin" | "user" | "project" | "plugin";
    } ? true : false;
    const mOk: _Manifest = true;
    expect(mOk).toBe(true);

    type _Ctx = import("./public").SlashCommandContext extends {
      args: string;
      emit: (event: string, payload: unknown) => Promise<void>;
      signal: AbortSignal;
    } ? true : false;
    const cOk: _Ctx = true;
    expect(cOk).toBe(true);

    type _Handler = import("./public").SlashCommandHandler extends
      (ctx: any) => Promise<void> ? true : false;
    const hOk: _Handler = true;
    expect(hOk).toBe(true);
  });

  it("re-exports tui:completion interface types", () => {
    type _Svc = import("./public").TuiCompletionService extends {
      register: (...a: any[]) => () => void;
    } ? true : false;
    const ok: _Svc = true;
    expect(ok).toBe(true);

    type _Source = import("./public").CompletionSource extends {
      trigger: string | RegExp;
      list: (input: string, cursor: number) => Promise<any[]>;
    } ? true : false;
    const sOk: _Source = true;
    expect(sOk).toBe(true);

    type _Item = import("./public").CompletionItem extends {
      label: string;
      insertText: string;
    } ? true : false;
    const iOk: _Item = true;
    expect(iOk).toBe(true);
  });

  it("CODEMODE_CANCEL_SENTINEL is the well-known string", async () => {
    const mod = await import("./index.ts");
    expect(mod.CODEMODE_CANCEL_SENTINEL).toBe("__kaizen_cancel__");
  });

  it("provides llm-events:vocabulary and defines every event name", async () => {
    const ctx = makeCtx();
    await plugin.setup(ctx);
    expect(ctx.provided["llm-events:vocabulary"]).toBe(VOCAB);
    for (const name of Object.values(VOCAB)) {
      expect(ctx.defined).toContain(name);
    }
  });
});
