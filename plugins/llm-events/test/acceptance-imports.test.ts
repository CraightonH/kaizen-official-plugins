import { describe, it, expect } from "bun:test";

// Foundation names must remain importable from `llm-events/public.d.ts`
// without circular dependencies. Owner-specific service contracts are tested
// in their owner plugins' public surfaces.
import type {
  Vocab,
  EventName,
  ChatMessage,
  ToolCall,
  ToolSchema,
  ModelInfo,
  LLMRequest,
  LLMResponse,
  LLMStreamEvent,
  LLMCompleteService,
} from "../public";
import { CANCEL_TOOL, CODEMODE_CANCEL_SENTINEL } from "../index.ts";

describe("llm-events: Spec 0 acceptance-criteria imports", () => {
  it("CANCEL_TOOL is the well-known Symbol.for('kaizen.cancel')", () => {
    expect(CANCEL_TOOL as symbol).toBe(Symbol.for("kaizen.cancel"));
  });

  it("CODEMODE_CANCEL_SENTINEL is the well-known codemode cancellation string", () => {
    expect(CODEMODE_CANCEL_SENTINEL).toBe("__kaizen_cancel__");
  });

  it("foundation primitives remain importable from llm-events/public", async () => {
    const event: EventName = "llm:done";
    const toolCall: ToolCall = { id: "call_1", name: "echo", arguments: { text: "ok" } };
    const tool: ToolSchema = {
      name: "echo",
      description: "Echo text.",
      parameters: { type: "object", properties: { text: { type: "string" } } },
    };
    const request: LLMRequest = {
      messages: [{ role: "user", content: "hello" }],
      tools: [tool],
    };
    const response: LLMResponse = {
      content: "",
      toolCalls: [toolCall],
      finishReason: "tool_calls",
    };
    const model: ModelInfo = { id: "local-model", loadedContextLength: 8192 };
    const stream: LLMStreamEvent = { type: "done", response };
    const service: LLMCompleteService = {
      async *complete() { yield stream; },
      async listModels() { return [model]; },
    };

    expect(event).toBe("llm:done");
    expect(request.tools?.[0]?.name).toBe("echo");
    await expect(service.listModels()).resolves.toEqual([model]);
  });

  it("every foundation type name resolves at the declaration level", () => {
    type _V = Vocab;
    type _En = EventName;
    type _Cm = ChatMessage;
    type _Tc = ToolCall;
    type _Ts = ToolSchema;
    type _Mi = ModelInfo;
    type _Lreq = LLMRequest;
    type _Lres = LLMResponse;
    type _Lse = LLMStreamEvent;
    type _Lcs = LLMCompleteService;

    // Use one at runtime so TS doesn't elide the whole import.
    const probe: _Cm = { role: "user", content: "ok" };
    expect(probe.role).toBe("user");
  });
});
