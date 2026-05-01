import { describe, it, expect } from "bun:test";

// The Spec 0 acceptance criteria require Tier 1+ plugins to be able to import
// every one of these names from `llm-events/public.d.ts` without circular
// dependencies. This test imports them together; if any name is missing or
// renamed, this file fails to type-check and `bun test` reports the error.
import type {
  Vocab,
  ChatMessage,
  ToolCall,
  ToolSchema,
  LLMRequest,
  LLMResponse,
  LLMStreamEvent,
  ToolsRegistryService,
  ToolExecutionContext,
  ToolDispatchStrategy,
  DriverService,
  SkillsRegistryService,
  AgentsRegistryService,
  SlashRegistryService,
  TuiCompletionService,
  CompletionSource,
  CompletionItem,
} from "../public";
import { CANCEL_TOOL } from "../index.ts";

describe("llm-events: Spec 0 acceptance-criteria imports", () => {
  it("CANCEL_TOOL is the well-known Symbol.for('kaizen.cancel')", () => {
    expect(CANCEL_TOOL).toBe(Symbol.for("kaizen.cancel"));
  });

  it("every Spec 0 type name resolves at the declaration level", () => {
    type _V = Vocab;
    type _Cm = ChatMessage;
    type _Tc = ToolCall;
    type _Ts = ToolSchema;
    type _Lreq = LLMRequest;
    type _Lres = LLMResponse;
    type _Lse = LLMStreamEvent;
    type _Trs = ToolsRegistryService;
    type _Tec = ToolExecutionContext;
    type _Tds = ToolDispatchStrategy;
    type _Ds = DriverService;
    type _Skr = SkillsRegistryService;
    type _Agr = AgentsRegistryService;
    type _Slr = SlashRegistryService;
    type _Tcs = TuiCompletionService;
    type _Cs = CompletionSource;
    type _Ci = CompletionItem;

    // Use one at runtime so TS doesn't elide the whole import.
    const probe: _Cm = { role: "user", content: "ok" };
    expect(probe.role).toBe("user");
  });
});
