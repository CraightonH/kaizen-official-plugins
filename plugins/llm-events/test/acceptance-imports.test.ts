import { describe, it, expect } from "bun:test";

// The Spec 0 acceptance criteria require Tier 1+ plugins to be able to import
// the foundational names from `llm-events/public.d.ts` without circular
// dependencies. This test imports them together; if any name is missing or
// renamed, this file fails to type-check and `bun test` reports the error.
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
  ToolsRegistryService,
  ToolRegistration,
  ToolSource,
  ToolExecutionContext,
  ToolDispatchStrategy,
  SkillRescanResult,
  SkillsRegistryService,
  AgentsRegistryService,
  SlashCommandContext,
  SlashCommandHandler,
  SlashCommandManifest,
  SlashRegistryEntry,
  SlashRegistryService,
  TuiCompletionService,
  CompletionSource,
  CompletionItem,
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

  it("every foundational Spec 0 type name resolves at the declaration level", () => {
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
    type _Trs = ToolsRegistryService;
    type _Tr = ToolRegistration;
    type _Tsrc = ToolSource;
    type _Tec = ToolExecutionContext;
    type _Tds = ToolDispatchStrategy;
    type _Srr = SkillRescanResult;
    type _Skr = SkillsRegistryService;
    type _Agr = AgentsRegistryService;
    type _Scm = SlashCommandManifest;
    type _Scc = SlashCommandContext;
    type _Sch = SlashCommandHandler;
    type _Sre = SlashRegistryEntry;
    type _Slr = SlashRegistryService;
    type _Tcs = TuiCompletionService;
    type _Cs = CompletionSource;
    type _Ci = CompletionItem;

    // Use one at runtime so TS doesn't elide the whole import.
    const probe: _Cm = { role: "user", content: "ok" };
    expect(probe.role).toBe("user");
  });
});
