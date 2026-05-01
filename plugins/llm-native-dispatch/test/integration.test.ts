// plugins/llm-native-dispatch/test/integration.test.ts
import { describe, it, expect, mock } from "bun:test";
import { makeRegistry } from "llm-tools-registry/registry";
import { makeStrategy } from "../strategy.ts";
import type { LLMResponse, ToolCall } from "llm-events/public";

function tc(id: string, name: string, args: unknown): ToolCall { return { id, name, arguments: args }; }

describe("integration: registry + strategy", () => {
  it("happy path: strategy → registry.invoke emits tool:* events; conversation is well-formed", async () => {
    const events: { name: string; payload: any }[] = [];
    const emit = mock(async (n: string, p: any) => { events.push({ name: n, payload: p }); });
    const registry = makeRegistry(emit as any);
    registry.register(
      { name: "echo", description: "", parameters: { type: "object" } as any },
      async (a) => ({ got: a }),
    );
    const strategy = makeStrategy();

    const response: LLMResponse = {
      content: "",
      toolCalls: [tc("c1", "echo", { x: 1 })],
      finishReason: "tool_calls",
    };
    const out = await strategy.handleResponse({
      response,
      registry,
      signal: new AbortController().signal,
      emit: emit as any,
    });

    expect(out.length).toBe(2);
    expect(out[0]).toMatchObject({ role: "assistant" });
    expect(out[1]).toMatchObject({ role: "tool", toolCallId: "c1", name: "echo", content: '{"got":{"x":1}}' });

    const toolEvents = events.filter((e) => e.name.startsWith("tool:")).map((e) => e.name);
    expect(toolEvents).toEqual(["tool:before-execute", "tool:execute", "tool:result"]);
  });

  it("unknown tool: registry emits tool:error; strategy still produces well-formed tool message", async () => {
    const events: { name: string; payload: any }[] = [];
    const emit = mock(async (n: string, p: any) => { events.push({ name: n, payload: p }); });
    const registry = makeRegistry(emit as any);
    const strategy = makeStrategy();

    const response: LLMResponse = {
      content: "",
      toolCalls: [tc("c1", "missing", {})],
      finishReason: "tool_calls",
    };
    const out = await strategy.handleResponse({
      response,
      registry,
      signal: new AbortController().signal,
      emit: emit as any,
    });

    expect(out.length).toBe(2);
    expect((out[1] as any).content).toMatch(/unknown tool/);
    const toolErr = events.find((e) => e.name === "tool:error");
    expect(toolErr).toBeDefined();
    expect(toolErr?.payload).toMatchObject({ name: "missing", callId: "c1" });
  });

  it("CANCEL_TOOL via subscriber: strategy receives rejection and produces error tool message", async () => {
    const { CANCEL_TOOL } = await import("llm-events");
    const subscribers: Record<string, ((p: any) => void)[]> = {};
    const emit = async (n: string, p: any) => {
      for (const fn of subscribers[n] ?? []) fn(p);
    };
    subscribers["tool:before-execute"] = [(p: any) => { p.args = CANCEL_TOOL; }];

    const registry = makeRegistry(emit as any);
    registry.register(
      { name: "noop", description: "", parameters: { type: "object" } as any },
      async () => "should not be called",
    );
    const strategy = makeStrategy();

    const response: LLMResponse = {
      content: "",
      toolCalls: [tc("c1", "noop", {})],
      finishReason: "tool_calls",
    };
    const out = await strategy.handleResponse({
      response,
      registry,
      signal: new AbortController().signal,
      emit: emit as any,
    });

    expect(out.length).toBe(2);
    const parsed = JSON.parse((out[1] as any).content);
    expect(parsed.error).toMatch(/cancelled/);
  });

  it("two parallel-ish tool calls execute sequentially through the registry", async () => {
    const order: string[] = [];
    const emit = mock(async () => {});
    const registry = makeRegistry(emit as any);
    registry.register(
      { name: "a", description: "", parameters: { type: "object" } as any },
      async () => { order.push("a-start"); await new Promise((r) => setTimeout(r, 5)); order.push("a-end"); return "ra"; },
    );
    registry.register(
      { name: "b", description: "", parameters: { type: "object" } as any },
      async () => { order.push("b-start"); order.push("b-end"); return "rb"; },
    );
    const strategy = makeStrategy();

    const response: LLMResponse = {
      content: "",
      toolCalls: [tc("1", "a", {}), tc("2", "b", {})],
      finishReason: "tool_calls",
    };
    await strategy.handleResponse({
      response,
      registry,
      signal: new AbortController().signal,
      emit: emit as any,
    });
    expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });
});
