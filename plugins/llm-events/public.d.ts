export type {
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
} from "llm-contracts/public";

export { CANCEL_TOOL } from "llm-contracts/public";

/**
 * Cancellation sentinel for `codemode:before-execute` subscribers. Set
 * `event.code = CODEMODE_CANCEL_SENTINEL` to abort code execution. The
 * codemode runner surfaces a cancelled execution as a `codemode:error`
 * with message `"cancelled"`.
 */
export declare const CODEMODE_CANCEL_SENTINEL: "__kaizen_cancel__";
