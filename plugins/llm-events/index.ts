import type { KaizenPlugin } from "kaizen/types";
import type { Vocab } from "llm-contracts/public";
export { CANCEL_TOOL } from "llm-contracts/public";
export const CODEMODE_CANCEL_SENTINEL = "__kaizen_cancel__" as const;

export const VOCAB: Vocab = Object.freeze({
  HARNESS_START: "harness:start",
  HARNESS_END: "harness:end",
  HARNESS_ERROR: "harness:error",
  HARNESS_EXIT_REQUESTED: "harness:exit-requested",
  SESSION_CREATED: "session:created",
  SESSION_RESUMED: "session:resumed",
  SESSION_DELETED: "session:deleted",
  SESSION_ACTIVE_CHANGED: "session:active-changed",
  SESSION_RENAMED: "session:renamed",
  SESSION_HANDOFF: "session:handoff",
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
  TOOL_PROGRESS: "tool:progress",
  CODEMODE_CODE_EMITTED: "codemode:code-emitted",
  CODEMODE_BEFORE_EXECUTE: "codemode:before-execute",
  CODEMODE_RESULT: "codemode:result",
  CODEMODE_ERROR: "codemode:error",
  SKILL_LOADED: "skill:loaded",
  SKILL_AVAILABLE_CHANGED: "skill:available-changed",
  STATUS_ITEM_UPDATE: "status:item-update",
  STATUS_ITEM_CLEAR: "status:item-clear",
  PROMPT_REBUILT: "prompt:rebuilt",
  PROMPT_RELOAD: "prompt:reload",
  TOOLS_REGISTERED: "tools:registered",
  TOOLS_UNREGISTERED: "tools:unregistered",
  MCP_REGISTRATION_CONFLICT: "mcp:registration-conflict",
  AGENT_DISPATCH_START: "agent:dispatch:start",
  AGENT_DISPATCH_END: "agent:dispatch:end",
  WORKFLOW_START: "workflow:start",
  WORKFLOW_PHASE: "workflow:phase",
  WORKFLOW_AGENT_START: "workflow:agent-start",
  WORKFLOW_AGENT_END: "workflow:agent-end",
  WORKFLOW_LOG: "workflow:log",
  WORKFLOW_END: "workflow:end",
} as const);

const plugin: KaizenPlugin = {
  name: "llm-events",
  apiVersion: "3.0.0",
  permissions: { tier: "trusted" },
  services: { provides: ["events:vocabulary"] },

  async setup(ctx) {
    ctx.provideService<Vocab>("events:vocabulary", VOCAB);
    for (const name of Object.values(VOCAB)) ctx.defineEvent(name);
  },
};

export default plugin;
