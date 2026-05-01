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

// ---------- tools:registry (owned by `llm-tools-registry`) ----------

export interface ToolHandler {
  (args: unknown, ctx: ToolExecutionContext): Promise<unknown>;
}

export interface ToolExecutionContext {
  signal: AbortSignal;
  callId: string;
  /**
   * Id of the turn that triggered this tool call. Required when invoked from
   * inside a driver turn (used by `llm-agents` to compute recursion depth and
   * link parent/child turns); optional when invoked outside a turn (tests,
   * slash commands, ad-hoc registry use).
   */
  turnId?: string;
  log: (msg: string) => void;
}

export interface ToolsRegistryService {
  /** Returns an unregister function. */
  register(schema: ToolSchema, handler: ToolHandler): () => void;
  list(filter?: { tags?: string[]; names?: string[] }): ToolSchema[];
  /**
   * Single execution entry point. Emits `tool:before-execute`, `tool:execute`,
   * `tool:result` / `tool:error` around the handler call. Subscribers to
   * `tool:before-execute` may rewrite `args`, or set `args` to `CANCEL_TOOL`
   * to abort — the registry surfaces a cancelled call as `tool:error` with
   * message `"cancelled"`.
   */
  invoke(name: string, args: unknown, ctx: ToolExecutionContext): Promise<unknown>;
}

// ---------- tool-dispatch:strategy (owned by `llm-native-dispatch`, `llm-codemode-dispatch`) ----------

/**
 * Bridge between LLM output and tool execution. Multiple strategies may exist;
 * the harness selects one by service name.
 */
export interface ToolDispatchStrategy {
  /**
   * Called by the driver before each LLM call. Returns *additions* to the
   * outgoing request — never replaces caller-owned fields.
   *   - `tools`: native dispatch fills this with the OpenAI tools schema.
   *   - `systemPromptAppend`: code-mode dispatch fills this with the rendered
   *     `.d.ts` API surface and code-block instructions.
   */
  prepareRequest(input: {
    availableTools: ToolSchema[];
  }): { tools?: ToolSchema[]; systemPromptAppend?: string };

  /**
   * Consumes a complete LLM response, executes any tool calls / code blocks,
   * and returns the messages that should be appended to the conversation.
   * Returns an empty array if the response was terminal (no further turn needed).
   */
  handleResponse(input: {
    response: LLMResponse;
    registry: ToolsRegistryService;
    signal: AbortSignal;
    emit: (event: string, payload: unknown) => Promise<void>;
  }): Promise<ChatMessage[]>;
}

// ---------- driver:run-conversation (owned by `llm-driver`) ----------

export interface RunConversationInput {
  systemPrompt: string;
  messages: ChatMessage[];
  /** Restricts the tool registry view for this nested run. */
  toolFilter?: { tags?: string[]; names?: string[] };
  /** Override default model for this run. */
  model?: string;
  /** For nested-turn telemetry (set by `llm-agents` when dispatching sub-agents). */
  parentTurnId?: string;
  signal?: AbortSignal;
}

export interface RunConversationOutput {
  finalMessage: ChatMessage;
  /** Full transcript including the input messages. */
  messages: ChatMessage[];
  usage: { promptTokens: number; completionTokens: number };
}

export interface DriverService {
  runConversation(input: RunConversationInput): Promise<RunConversationOutput>;
}

// ---------- skills:registry (owned by `llm-skills`) ----------

export interface SkillManifest {
  name: string;
  description: string;
  /** Cached estimate, in tokens, used by budgeting code. */
  tokens?: number;
}

export interface SkillsRegistryService {
  list(): SkillManifest[];
  /** Returns the body to inject into the system prompt. */
  load(name: string): Promise<string>;
  register(manifest: SkillManifest, loader: () => Promise<string>): () => void;
  /** Re-discover file-backed skills; used by `/skills reload`. */
  rescan(): Promise<void>;
}

// ---------- agents:registry (owned by `llm-agents`) ----------

export interface AgentManifest {
  name: string;
  description: string;
  systemPrompt: string;
  /** Restricts the tool view available to this agent's nested driver runs. */
  toolFilter?: { tags?: string[]; names?: string[] };
}

export interface AgentsRegistryService {
  list(): AgentManifest[];
  register(manifest: AgentManifest): () => void;
}

// ---------- slash:registry (owned by `llm-slash-commands`) ----------

export interface SlashCommandManifest {
  /** Without leading slash, e.g. "help" or "mcp:reload". */
  name: string;
  description: string;
  /**
   * If set, the command body is rendered with `{{args}}` substitution and
   * re-emitted as a user message. If unset, `handler` runs.
   */
  body?: string;
  source: "builtin" | "user" | "project" | "plugin";
}

export interface SlashCommandContext {
  /** Everything after the command name; a single leading space is stripped. */
  args: string;
  emit: (event: string, payload: unknown) => Promise<void>;
  signal: AbortSignal;
}

export interface SlashCommandHandler {
  (ctx: SlashCommandContext): Promise<void>;
}

export interface SlashRegistryService {
  register(manifest: SlashCommandManifest, handler?: SlashCommandHandler): () => void;
  list(): SlashCommandManifest[];
  /**
   * Returns true if the input matched a registered command (and was dispatched);
   * false if no match. Subscribers to `input:submit` call this to decide
   * whether to emit `input:handled`.
   */
  tryDispatch(input: string, ctx: Omit<SlashCommandContext, "args">): Promise<boolean>;
}

// ---------- tui:completion (owned by `llm-tui`) ----------

export interface CompletionItem {
  /** Shown in the popup. */
  label: string;
  /** Replaces trigger+typed-text on accept. */
  insertText: string;
  /** Shown alongside `label`. */
  description?: string;
  /** Shown below the selection (preview/help). */
  detail?: string;
}

export interface CompletionSource {
  /** Matched at word-start in the input field. */
  trigger: string | RegExp;
  list(input: string, cursor: number): Promise<CompletionItem[]>;
  /** Higher weight sorts first when multiple sources merge into one popup. */
  weight?: number;
}

export interface TuiCompletionService {
  register(source: CompletionSource): () => void;
}

export declare const CANCEL_TOOL: unique symbol;
