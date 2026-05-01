// plugins/llm-native-dispatch/test/strategy.test.ts
import { describe, it, expect, mock } from "bun:test";
import { makeStrategy } from "../strategy.ts";
import type { ToolsRegistryService } from "llm-tools-registry/public";
import type { ToolCall, LLMResponse, ToolSchema } from "llm-events/public";

function fakeRegistry(handlers: Record<string, (args: unknown) => Promise<unknown> | unknown>): ToolsRegistryService {
  const list: ToolSchema[] = [];
  return {
    register: () => () => {},
    list: () => list,
    invoke: async (name: string, args: unknown) => {
      const h = handlers[name];
      if (!h) throw new Error(`unknown tool: ${name}`);
      return await h(args);
    },
  };
}

const SCHEMA = (n: string): ToolSchema => ({ name: n, description: "", parameters: { type: "object" } as any });

function tc(id: string, name: string, args: unknown): ToolCall { return { id, name, arguments: args }; }
const noEmit = mock(async () => {});

describe("prepareRequest", () => {
  it("passes through available tools", () => {
    const s = makeStrategy();
    const out = s.prepareRequest({ availableTools: [SCHEMA("a"), SCHEMA("b")] });
    expect(out.tools?.map((t) => t.name)).toEqual(["a", "b"]);
    expect(out.systemPromptAppend).toBeUndefined();
  });

  it("empty tools → empty tools", () => {
    const s = makeStrategy();
    expect(s.prepareRequest({ availableTools: [] })).toEqual({ tools: [] });
  });
});

describe("handleResponse — terminal", () => {
  it("no toolCalls → []", async () => {
    const s = makeStrategy();
    const r: LLMResponse = { content: "done", finishReason: "stop" };
    const out = await s.handleResponse({
      response: r,
      registry: fakeRegistry({}),
      signal: new AbortController().signal,
      emit: noEmit,
    });
    expect(out).toEqual([]);
  });

  it("empty toolCalls array → []", async () => {
    const s = makeStrategy();
    const r: LLMResponse = { content: "done", toolCalls: [], finishReason: "stop" };
    const out = await s.handleResponse({
      response: r,
      registry: fakeRegistry({}),
      signal: new AbortController().signal,
      emit: noEmit,
    });
    expect(out).toEqual([]);
  });
});

describe("handleResponse — tool calls", () => {
  it("one tool call → [assistant, tool] with serialized result", async () => {
    const s = makeStrategy();
    const r: LLMResponse = {
      content: "",
      toolCalls: [tc("c1", "echo", { x: 1 })],
      finishReason: "tool_calls",
    };
    const out = await s.handleResponse({
      response: r,
      registry: fakeRegistry({ echo: (a) => ({ got: a }) }),
      signal: new AbortController().signal,
      emit: noEmit,
    });
    expect(out.length).toBe(2);
    expect(out[0]).toMatchObject({ role: "assistant", toolCalls: r.toolCalls });
    expect(out[1]).toMatchObject({
      role: "tool",
      toolCallId: "c1",
      name: "echo",
      content: '{"got":{"x":1}}',
    });
  });

  it("three tool calls → [assistant, t1, t2, t3] in order, sequential", async () => {
    const s = makeStrategy();
    const order: string[] = [];
    const reg = fakeRegistry({
      a: async () => { order.push("a"); return "ra"; },
      b: async () => { order.push("b"); return "rb"; },
      c: async () => { order.push("c"); return "rc"; },
    });
    const r: LLMResponse = {
      content: "",
      toolCalls: [tc("1", "a", {}), tc("2", "b", {}), tc("3", "c", {})],
      finishReason: "tool_calls",
    };
    const out = await s.handleResponse({
      response: r,
      registry: reg,
      signal: new AbortController().signal,
      emit: noEmit,
    });
    expect(order).toEqual(["a", "b", "c"]);
    expect(out.length).toBe(4);
    expect(out.slice(1).map((m) => (m as any).toolCallId)).toEqual(["1", "2", "3"]);
  });

  it("handler throw → tool message with serialized error; subsequent calls still execute", async () => {
    const s = makeStrategy();
    const reg = fakeRegistry({
      a: async () => { throw new Error("boom"); },
      b: async () => "ok",
    });
    const r: LLMResponse = {
      content: "",
      toolCalls: [tc("1", "a", {}), tc("2", "b", {})],
      finishReason: "tool_calls",
    };
    const out = await s.handleResponse({
      response: r,
      registry: reg,
      signal: new AbortController().signal,
      emit: noEmit,
    });
    expect((out[1] as any).content).toBe('{"error":"boom"}');
    expect((out[2] as any).content).toBe("ok");
  });

  it("unknown tool name → serialized error tool message", async () => {
    const s = makeStrategy();
    const r: LLMResponse = {
      content: "",
      toolCalls: [tc("1", "missing", {})],
      finishReason: "tool_calls",
    };
    const out = await s.handleResponse({
      response: r,
      registry: fakeRegistry({}),
      signal: new AbortController().signal,
      emit: noEmit,
    });
    expect((out[1] as any).content).toMatch(/unknown tool/);
  });

  it("malformed arguments (string) skips registry.invoke and emits tool:error", async () => {
    const s = makeStrategy();
    const emit = mock(async () => {});
    const reg = fakeRegistry({ a: async () => { throw new Error("should not be called"); } });
    const r: LLMResponse = {
      content: "",
      toolCalls: [tc("1", "a", "{not json")],
      finishReason: "tool_calls",
    };
    const out = await s.handleResponse({
      response: r,
      registry: reg,
      signal: new AbortController().signal,
      emit: emit as any,
    });
    const parsed = JSON.parse((out[1] as any).content);
    expect(parsed.error).toMatch(/malformed/);
    expect(parsed.raw).toBe("{not json");
    const calls = (emit as any).mock.calls.map((c: any[]) => c[0]);
    expect(calls).toContain("tool:error");
  });

  it("aborted signal mid-loop → remaining calls get 'cancelled' tool messages", async () => {
    const ac = new AbortController();
    const s = makeStrategy();
    const reg = fakeRegistry({
      a: async () => { ac.abort(); return "ra"; }, // first call aborts the signal
      b: async () => "rb",
      c: async () => "rc",
    });
    const r: LLMResponse = {
      content: "",
      toolCalls: [tc("1", "a", {}), tc("2", "b", {}), tc("3", "c", {})],
      finishReason: "tool_calls",
    };
    const out = await s.handleResponse({
      response: r,
      registry: reg,
      signal: ac.signal,
      emit: noEmit,
    });
    expect(out.length).toBe(4);
    expect((out[1] as any).content).toBe("ra");
    expect(JSON.parse((out[2] as any).content)).toEqual({ error: "cancelled" });
    expect(JSON.parse((out[3] as any).content)).toEqual({ error: "cancelled" });
  });

  it("circular result emits tool:error and falls back to String() content", async () => {
    const emit = mock(async () => {});
    const s = makeStrategy();
    const o: any = { a: 1 };
    o.self = o;
    const reg = fakeRegistry({ a: async () => o });
    const r: LLMResponse = {
      content: "",
      toolCalls: [tc("1", "a", {})],
      finishReason: "tool_calls",
    };
    const out = await s.handleResponse({
      response: r,
      registry: reg,
      signal: new AbortController().signal,
      emit: emit as any,
    });
    expect((out[1] as any).content).toBe(String(o));
    const evNames = (emit as any).mock.calls.map((c: any[]) => c[0]);
    expect(evNames).toContain("tool:error");
  });

  it("undefined result → empty content", async () => {
    const s = makeStrategy();
    const reg = fakeRegistry({ a: async () => undefined });
    const r: LLMResponse = {
      content: "",
      toolCalls: [tc("1", "a", {})],
      finishReason: "tool_calls",
    };
    const out = await s.handleResponse({
      response: r,
      registry: reg,
      signal: new AbortController().signal,
      emit: noEmit,
    });
    expect((out[1] as any).content).toBe("");
  });

  it("ctx.log forwards to emit('status:item-update')", async () => {
    const emit = mock(async () => {});
    const s = makeStrategy();
    const reg: ToolsRegistryService = {
      register: () => () => {},
      list: () => [],
      invoke: async (_n, _a, ctx) => { ctx.log("hello"); return "ok"; },
    };
    await s.handleResponse({
      response: { content: "", toolCalls: [tc("c1", "a", {})], finishReason: "tool_calls" },
      registry: reg,
      signal: new AbortController().signal,
      emit: emit as any,
    });
    const statusCall = (emit as any).mock.calls.find((c: any[]) => c[0] === "status:item-update");
    expect(statusCall).toBeDefined();
    expect(statusCall[1]).toEqual({ key: "tool:c1", value: "hello" });
  });
});
