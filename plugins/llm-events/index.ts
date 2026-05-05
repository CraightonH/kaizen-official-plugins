import type { KaizenPlugin } from "kaizen/types";
import type { Vocab } from "./public";

export const CANCEL_TOOL: unique symbol = Symbol.for("kaizen.cancel") as any;
export const CODEMODE_CANCEL_SENTINEL = "__kaizen_cancel__" as const;

export const VOCAB: Vocab = Object.freeze({
  SESSION_START: "session:start",
  SESSION_END: "session:end",
  SESSION_ERROR: "session:error",
  SESSION_EXIT_REQUESTED: "session:exit-requested",
  INPUT_SUBMIT: "input:submit",
  INPUT_HANDLED: "input:handled",
  CONVERSATION_USER_MESSAGE: "conversation:user-message",
  CONVERSATION_ASSISTANT_MESSAGE: "conversation:assistant-message",
  CONVERSATION_SYSTEM_MESSAGE: "conversation:system-message",
  CONVERSATION_CLEARED: "conversation:cleared",
  TURN_START: "turn:start",
  TURN_END: "turn:end",
  TURN_CANCEL: "turn:cancel",
  TURN_ERROR: "turn:error",
  LLM_BEFORE_CALL: "llm:before-call",
  LLM_REQUEST: "llm:request",
  LLM_TOKEN: "llm:token",
  LLM_REASONING: "llm:reasoning",
  LLM_TOOL_CALL: "llm:tool-call",
  LLM_DONE: "llm:done",
  LLM_ERROR: "llm:error",
  TOOL_BEFORE_EXECUTE: "tool:before-execute",
  TOOL_EXECUTE: "tool:execute",
  TOOL_RESULT: "tool:result",
  TOOL_ERROR: "tool:error",
  CODEMODE_CODE_EMITTED: "codemode:code-emitted",
  CODEMODE_BEFORE_EXECUTE: "codemode:before-execute",
  CODEMODE_RESULT: "codemode:result",
  CODEMODE_ERROR: "codemode:error",
  SKILL_LOADED: "skill:loaded",
  SKILL_AVAILABLE_CHANGED: "skill:available-changed",
  STATUS_ITEM_UPDATE: "status:item-update",
  STATUS_ITEM_CLEAR: "status:item-clear",
} as const);

const plugin: KaizenPlugin = {
  name: "llm-events",
  apiVersion: "3.0.0",
  permissions: { tier: "trusted" },
  services: { provides: ["llm-events:vocabulary"] },

  async setup(ctx) {
    ctx.defineService("llm-events:vocabulary", {
      description: "Event-name vocabulary for the openai-compatible harness.",
    });
    ctx.provideService<Vocab>("llm-events:vocabulary", VOCAB);
    for (const name of Object.values(VOCAB)) ctx.defineEvent(name);
  },
};

export default plugin;
