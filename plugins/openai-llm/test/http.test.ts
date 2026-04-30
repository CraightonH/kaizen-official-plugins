import { describe, it, expect } from "bun:test";
import { buildHeaders, buildChatBody, mapMessages, mapTools } from "../http.ts";
import { DEFAULT_CONFIG } from "../config.ts";
import type { LLMRequest } from "llm-events/public";

const cfg = { ...DEFAULT_CONFIG, apiKey: "sk-x", extraHeaders: { "OpenAI-Beta": "v1" } };

describe("buildHeaders", () => {
  it("includes content-type, accept, ua", () => {
    const h = buildHeaders({ ...cfg, apiKey: "" }, "0.1.0");
    expect(h["Content-Type"]).toBe("application/json");
    expect(h["Accept"]).toBe("text/event-stream");
    expect(h["User-Agent"]).toMatch(/^kaizen-openai-llm\/0\.1\.0$/);
    expect(h["Authorization"]).toBeUndefined();
  });
  it("adds Authorization Bearer when apiKey set", () => {
    const h = buildHeaders(cfg, "0.1.0");
    expect(h["Authorization"]).toBe("Bearer sk-x");
  });
  it("merges extraHeaders last (override wins)", () => {
    const h = buildHeaders({ ...cfg, extraHeaders: { "User-Agent": "custom" } }, "0.1.0");
    expect(h["User-Agent"]).toBe("custom");
  });
});

describe("mapMessages", () => {
  it("passes role/content through", () => {
    expect(mapMessages([{ role: "user", content: "hi" }])).toEqual([{ role: "user", content: "hi" }]);
  });
  it("re-stringifies tool-call arguments and renames tool_call_id", () => {
    const out = mapMessages([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "f", arguments: { a: 1 } }] },
      { role: "tool", content: "ok", toolCallId: "c1", name: "f" },
    ]);
    expect(out[0]).toEqual({
      role: "assistant",
      content: "",
      tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: JSON.stringify({ a: 1 }) } }],
    });
    expect(out[1]).toEqual({ role: "tool", content: "ok", tool_call_id: "c1", name: "f" });
  });
});

describe("mapTools", () => {
  it("maps to OpenAI function-tool shape and drops tags", () => {
    const out = mapTools([{ name: "f", description: "d", parameters: { type: "object" }, tags: ["x"] }]);
    expect(out).toEqual([{ type: "function", function: { name: "f", description: "d", parameters: { type: "object" } } }]);
  });
});

describe("buildChatBody", () => {
  const req: LLMRequest = {
    model: "",
    messages: [{ role: "user", content: "hi" }],
    systemPrompt: "be terse",
  };
  it("uses defaultModel when req.model is empty + prepends system + sets stream/usage", () => {
    const body = buildChatBody(req, cfg);
    expect(body.model).toBe(cfg.defaultModel);
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.messages[0]).toEqual({ role: "system", content: "be terse" });
    expect(body.temperature).toBe(cfg.defaultTemperature);
    expect("max_tokens" in body).toBe(false);
    expect("stop" in body).toBe(false);
    expect("tools" in body).toBe(false);
  });
  it("does not duplicate system message when index 0 already system", () => {
    const body = buildChatBody({ ...req, messages: [{ role: "system", content: "ignore" }, { role: "user", content: "hi" }] }, cfg);
    expect(body.messages.filter((m: any) => m.role === "system").length).toBe(1);
    expect(body.messages[0].content).toBe("ignore");
  });
  it("includes tools and tool_choice:auto when req.tools present", () => {
    const body = buildChatBody({ ...req, tools: [{ name: "f", description: "d", parameters: {} }] }, cfg);
    expect(Array.isArray(body.tools)).toBe(true);
    expect(body.tool_choice).toBe("auto");
  });
  it("req.extra shallow-merges last and wins on collisions", () => {
    const body = buildChatBody({ ...req, temperature: 0.1, extra: { temperature: 0.9, top_p: 0.5 } }, cfg);
    expect(body.temperature).toBe(0.9);
    expect(body.top_p).toBe(0.5);
  });
  it("rejects req.extra.n > 1 by throwing", () => {
    expect(() => buildChatBody({ ...req, extra: { n: 2 } }, cfg)).toThrow(/multiple choices/i);
  });
});
