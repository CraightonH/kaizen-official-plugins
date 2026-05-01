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

  it("provides llm-events:vocabulary and defines every event name", async () => {
    const ctx = makeCtx();
    await plugin.setup(ctx);
    expect(ctx.provided["llm-events:vocabulary"]).toBe(VOCAB);
    for (const name of Object.values(VOCAB)) {
      expect(ctx.defined).toContain(name);
    }
  });
});
