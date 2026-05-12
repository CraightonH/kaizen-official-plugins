import type { JSONSchema7 } from "json-schema";

export interface Vocab {
  readonly HARNESS_START: "harness:start";
  readonly HARNESS_END: "harness:end";
  readonly HARNESS_ERROR: "harness:error";
  readonly HARNESS_EXIT_REQUESTED: "harness:exit-requested";
  readonly SESSION_CREATED: "session:created";
  readonly SESSION_RESUMED: "session:resumed";
  readonly SESSION_DELETED: "session:deleted";
  readonly SESSION_ACTIVE_CHANGED: "session:active-changed";
  readonly SESSION_RENAMED: "session:renamed";
  readonly SESSION_HANDOFF: "session:handoff";
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
  readonly LLM_REASONING: "llm:reasoning";
  readonly LLM_TOOL_CALL: "llm:tool-call";
  readonly LLM_DONE: "llm:done";
  readonly LLM_ERROR: "llm:error";
  readonly TOOL_BEFORE_EXECUTE: "tool:before-execute";
  readonly TOOL_EXECUTE: "tool:execute";
  readonly TOOL_RESULT: "tool:result";
  readonly TOOL_ERROR: "tool:error";
  readonly TOOL_PROGRESS: "tool:progress";
  readonly CODEMODE_CODE_EMITTED: "codemode:code-emitted";
  readonly CODEMODE_BEFORE_EXECUTE: "codemode:before-execute";
  readonly CODEMODE_RESULT: "codemode:result";
  readonly CODEMODE_ERROR: "codemode:error";
  readonly SKILL_LOADED: "skill:loaded";
  readonly SKILL_AVAILABLE_CHANGED: "skill:available-changed";
  readonly STATUS_ITEM_UPDATE: "status:item-update";
  readonly STATUS_ITEM_CLEAR: "status:item-clear";
  readonly PROMPT_REBUILT: "prompt:rebuilt";
  readonly PROMPT_RELOAD: "prompt:reload";
  readonly TOOLS_REGISTERED: "tools:registered";
  readonly TOOLS_UNREGISTERED: "tools:unregistered";
  readonly MCP_REGISTRATION_CONFLICT: "mcp:registration-conflict";
}
export type EventName = Vocab[keyof Vocab];

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
  /**
   * Optional, plugin-defined metadata about the message. Persisted with the
   * message in session snapshots. Reserved keys: `handoff` (set by
   * llm-session-manager when a session was seeded via `session:new` with a
   * prompt; payload is `{ from: <SessionId> }`).
   */
  meta?: Record<string, unknown>;
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
  /**
   * Generic context window. Most hosted providers return only this (or none).
   * Prefer `loadedContextLength` when populated — local runtimes (LM Studio,
   * vLLM, llama.cpp) let the operator load a model with a window smaller than
   * its advertised max, and that runtime ceiling is what callers care about.
   */
  contextLength?: number;
  /** Runtime-configured context window — what the loaded model will actually accept on this call. */
  loadedContextLength?: number;
  /** Advertised maximum the architecture supports, regardless of how it's loaded. */
  maxContextLength?: number;
  description?: string;
}

export interface LLMRequest {
  /**
   * Optional. When omitted, the LLM provider plugin substitutes its own
   * configured default model. Callers (drivers, agents) only set this to
   * override the provider default for a specific call.
   */
  model?: string;
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
  | { type: "reasoning"; delta: string }
  | { type: "tool-call"; toolCall: ToolCall }
  | { type: "done"; response: LLMResponse }
  | { type: "error"; message: string; cause?: unknown };

export interface LLMCompleteService {
  complete(req: LLMRequest, opts: { signal: AbortSignal }): AsyncIterable<LLMStreamEvent>;
  listModels(): Promise<ModelInfo[]>;
}

export declare const CANCEL_TOOL: unique symbol;

/**
 * Cancellation sentinel for `codemode:before-execute` subscribers. Set
 * `event.code = CODEMODE_CANCEL_SENTINEL` to abort code execution. The
 * codemode runner surfaces a cancelled execution as a `codemode:error`
 * with message `"cancelled"`.
 */
export declare const CODEMODE_CANCEL_SENTINEL: "__kaizen_cancel__";
