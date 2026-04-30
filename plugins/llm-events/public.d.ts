import type { JSONSchema7 } from "json-schema";

export interface Vocab {
  readonly SESSION_START: "session:start";
  readonly SESSION_END: "session:end";
  readonly SESSION_ERROR: "session:error";
  readonly INPUT_SUBMIT: "input:submit";
  readonly INPUT_HANDLED: "input:handled";
  readonly CONVERSATION_USER_MESSAGE: "conversation:user-message";
  readonly CONVERSATION_ASSISTANT_MESSAGE: "conversation:assistant-message";
  readonly CONVERSATION_SYSTEM_MESSAGE: "conversation:system-message";
  readonly CONVERSATION_CLEARED: "conversation:cleared";
  readonly TURN_START: "turn:start";
  readonly TURN_END: "turn:end";
  readonly TURN_CANCEL: "turn:cancel";
  readonly TURN_ERROR: "turn:error";
  readonly LLM_BEFORE_CALL: "llm:before-call";
  readonly LLM_REQUEST: "llm:request";
  readonly LLM_TOKEN: "llm:token";
  readonly LLM_TOOL_CALL: "llm:tool-call";
  readonly LLM_DONE: "llm:done";
  readonly LLM_ERROR: "llm:error";
  readonly TOOL_BEFORE_EXECUTE: "tool:before-execute";
  readonly TOOL_EXECUTE: "tool:execute";
  readonly TOOL_RESULT: "tool:result";
  readonly TOOL_ERROR: "tool:error";
  readonly CODEMODE_CODE_EMITTED: "codemode:code-emitted";
  readonly CODEMODE_BEFORE_EXECUTE: "codemode:before-execute";
  readonly CODEMODE_RESULT: "codemode:result";
  readonly CODEMODE_ERROR: "codemode:error";
  readonly SKILL_LOADED: "skill:loaded";
  readonly SKILL_AVAILABLE_CHANGED: "skill:available-changed";
  readonly STATUS_ITEM_UPDATE: "status:item-update";
  readonly STATUS_ITEM_CLEAR: "status:item-clear";
}
export type EventName = Vocab[keyof Vocab];

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: JSONSchema7;
  tags?: string[];
}

export interface ModelInfo {
  id: string;
  contextLength?: number;
  description?: string;
}

export interface LLMRequest {
  model: string;
  messages: ChatMessage[];
  systemPrompt?: string;
  tools?: ToolSchema[];
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
  /**
   * Provider-specific extras. Shallow-merged into the wire body AFTER standard
   * fields, so `extra` wins on field collisions (e.g. caller can override
   * `temperature`, `tool_choice`, etc.).
   */
  extra?: Record<string, unknown>;
  /**
   * Set by an `llm:before-call` subscriber to abort this LLM call. Driver
   * checks after the event resolves; if true, no HTTP request is made.
   */
  cancelled?: boolean;
}

export interface LLMResponse {
  content: string;
  toolCalls?: ToolCall[];
  finishReason: "stop" | "length" | "tool_calls" | "content_filter" | "error";
  usage?: { promptTokens: number; completionTokens: number };
}

export type LLMStreamEvent =
  | { type: "token"; delta: string }
  | { type: "tool-call"; toolCall: ToolCall }
  | { type: "done"; response: LLMResponse }
  | { type: "error"; message: string; cause?: unknown };

export interface LLMCompleteService {
  complete(req: LLMRequest, opts: { signal: AbortSignal }): AsyncIterable<LLMStreamEvent>;
  listModels(): Promise<ModelInfo[]>;
}

export declare const CANCEL_TOOL: unique symbol;
