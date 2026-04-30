# OpenAI-Compatible Harness — Foundation (Spec 0)

**Status:** draft
**Date:** 2026-04-30
**Scope:** Tier 0 only — event vocabulary, service interfaces, harness composition contract, and the `llm-events` plugin. All other plugins (`llm-driver`, `openai-llm`, dispatch strategies, capability plugins) are specified separately and depend on the contracts defined here.

## Goal

Establish the contracts that every downstream plugin in the openai-compatible harness ecosystem must satisfy. Once this spec is approved, Tier 1+ plugins can be specified and implemented in parallel without further coordination on shapes.

## Non-goals

- Implementation of any plugin other than `llm-events`.
- HTTP, streaming, sandboxing, tool execution — covered in dependent specs.
- Backwards compatibility with the existing `claude-events` vocabulary. The two harnesses coexist with separate vocabularies.

## Architectural overview

The harness is composed of small, single-purpose plugins that communicate exclusively through:

1. **Service registry** — typed function-table interfaces. Every cross-plugin RPC goes through here.
2. **Event bus** — fire-and-forget lifecycle notifications. Hooks are just subscribers.

The driver owns coordination only:

- The turn loop (assistant message → optional tool dispatch → loop until done).
- Conversation state (messages array, cancellation, token accounting).
- Lifecycle event emission.
- Exposing `driver:run-conversation` so other plugins (notably `llm-agents`) can recursively invoke the driver.

The driver does **not** know:

- How HTTP to the LLM works (`openai-llm` provides `llm:complete`).
- What tools exist (`llm-tools-registry` provides `tools:registry`).
- How tool calls are translated to/from LLM output (`tool-dispatch:strategy` providers).
- What skills, slash commands, memory, agents, or MCPs are. Those plugins participate via events and registries.

The only OpenAI-specific plugin is `openai-llm`. Swapping providers later (Anthropic, Bedrock, Ollama-native) means a new `*-llm` plugin that satisfies the `llm:complete` contract; nothing else changes.

## Tier breakdown (informational)

Driving the parallelization plan. Detailed specs for each tier will reference the contracts in this document.

- **Tier 0 (this spec):** `llm-events` + all service interfaces.
- **Tier 1 (A milestone, chat E2E):** `openai-llm`, `llm-driver`, harness file.
- **Tier 2 (B milestone, tool calls):** `llm-tools-registry` + `llm-native-dispatch`, `llm-codemode-dispatch`, `llm-local-tools`.
- **Tier 3 (C milestone, full agent harness):** `llm-skills`, `llm-slash-commands`, `llm-memory`, `llm-agents`, `llm-mcp-bridge`, optional plugins.

## Event vocabulary

Defined and exported by the `llm-events` plugin as a frozen `VOCAB` constant and registered with `ctx.defineEvent` for each name. Payloads are TS interfaces in `public.d.ts`.

### Session

| Event | Payload |
|---|---|
| `session:start` | `{}` |
| `session:end` | `{}` |
| `session:error` | `{ message: string; cause?: unknown }` |

### Input (user-facing intake, before driver dispatch)

| Event | Payload | Notes |
|---|---|---|
| `input:submit` | `{ text: string }` | TUI emits when user presses enter. |
| `input:handled` | `{ by: string }` | Subscriber claims the input; driver skips its default dispatch. Used by `llm-slash-commands`. |

### Conversation (logical message-history-level state)

| Event | Payload |
|---|---|
| `conversation:user-message` | `{ message: ChatMessage }` |
| `conversation:assistant-message` | `{ message: ChatMessage }` |
| `conversation:system-message` | `{ message: ChatMessage }` |
| `conversation:cleared` | `{}` |

### Turn (one `driver:run-conversation` invocation; may span many LLM calls)

| Event | Payload |
|---|---|
| `turn:start` | `{ turnId: string; trigger: "user" \| "agent"; parentTurnId?: string }` |
| `turn:end` | `{ turnId: string; reason: "complete" \| "cancelled" \| "error" }` |
| `turn:cancel` | `{ turnId?: string }` (omit to cancel current) |
| `turn:error` | `{ turnId: string; message: string; cause?: unknown }` |

### LLM call (one HTTP roundtrip)

| Event | Payload | Notes |
|---|---|---|
| `llm:before-call` | `{ request: LLMRequest }` (mutable) | Subscribers may mutate `request` in-place. Memory injection, system-prompt rewriting, model overrides happen here. To cancel the call entirely, set `request.cancelled = true`; the driver checks after all subscribers have resolved and ends the turn cleanly. |
| `llm:request` | `{ request: LLMRequest }` (immutable snapshot) | Post-mutation; for logging/observability only. |
| `llm:token` | `{ delta: string }` | Streaming chunk. |
| `llm:tool-call` | `{ toolCall: ToolCall }` | Native dispatch only. Code mode uses `codemode:*`. |
| `llm:done` | `{ response: LLMResponse }` |
| `llm:error` | `{ message: string; cause?: unknown }` |

### Tool execution (strategy-agnostic — both native and code mode emit these)

| Event | Payload | Notes |
|---|---|---|
| `tool:before-execute` | `{ name: string; args: unknown; callId: string }` (mutable) | Subscribers may rewrite `args`, or set `args` to the sentinel `CANCEL_TOOL` (`Symbol.for("kaizen.cancel")`) to cancel the call. The registry surfaces a cancelled call as a `tool:error` with message `"cancelled"`. |
| `tool:execute` | `{ name: string; args: unknown; callId: string }` |
| `tool:result` | `{ name: string; callId: string; result: unknown }` |
| `tool:error` | `{ name: string; callId: string; message: string; cause?: unknown }` |

### Code mode (separate because emitted code is a different artifact than a structured tool call)

| Event | Payload |
|---|---|
| `codemode:code-emitted` | `{ code: string; language: "typescript" \| "javascript" }` |
| `codemode:before-execute` | `{ code: string }` (mutable) |
| `codemode:result` | `{ stdout: string; returnValue: unknown }` |
| `codemode:error` | `{ message: string; cause?: unknown }` |

### Skills

| Event | Payload |
|---|---|
| `skill:loaded` | `{ name: string; tokens: number }` |
| `skill:available-changed` | `{ count: number }` |

### Status (carried over)

| Event | Payload |
|---|---|
| `status:item-update` | `{ key: string; value: string }` |
| `status:item-clear` | `{ key: string }` |

## Service interfaces

All interfaces live in plugin-local `public.d.ts` files. The owning plugin's name is given in parentheses; consumers import the type from that plugin.

### `llm-events:vocabulary` (`llm-events`)

```ts
export interface Vocab {
  readonly SESSION_START: "session:start";
  readonly SESSION_END: "session:end";
  // ... one entry per event listed above
}
```

Same shape as the existing `claude-events:vocabulary`. Consumers use the constant rather than string literals.

### `llm:complete` (`openai-llm`, or any future provider plugin)

The single point of contact between the driver and an LLM provider.

```ts
export interface LLMRequest {
  model: string;
  messages: ChatMessage[];
  systemPrompt?: string;
  tools?: ToolSchema[];        // populated only when native dispatch is active
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
  // Provider-specific extras land in `extra` and the provider plugin decides what to do.
  extra?: Record<string, unknown>;
  // Set by an `llm:before-call` subscriber to abort this LLM call. Driver checks
  // after the event resolves; if true, no HTTP request is made and the turn ends cleanly.
  cancelled?: boolean;
}

export interface LLMResponse {
  content: string;
  toolCalls?: ToolCall[];
  finishReason: "stop" | "length" | "tool_calls" | "content_filter" | "error";
  usage?: { promptTokens: number; completionTokens: number };
}

export interface LLMCompleteService {
  complete(req: LLMRequest, opts: { signal: AbortSignal }): AsyncIterable<LLMStreamEvent>;
  listModels(): Promise<ModelInfo[]>;
}

export type LLMStreamEvent =
  | { type: "token"; delta: string }
  | { type: "tool-call"; toolCall: ToolCall }
  | { type: "done"; response: LLMResponse }
  | { type: "error"; message: string; cause?: unknown };
```

`complete` is an async iterable so the driver can stream tokens to the TUI without buffering.

### `tools:registry` (`llm-tools-registry`)

```ts
export interface ToolSchema {
  name: string;
  description: string;
  parameters: JSONSchema7;
  // Tags allow capability plugins (agents, dispatch strategies) to filter the registry.
  tags?: string[];
}

export interface ToolHandler {
  (args: unknown, ctx: ToolExecutionContext): Promise<unknown>;
}

export interface ToolExecutionContext {
  signal: AbortSignal;
  callId: string;
  // The id of the turn that triggered this tool call. Used by `llm-agents` to
  // measure recursion depth and link parent/child turns. Optional only because
  // tools can be invoked outside a turn (tests, slash commands); inside a turn
  // it MUST be set by the dispatcher.
  turnId?: string;
  log: (msg: string) => void;
}

export interface ToolsRegistryService {
  register(schema: ToolSchema, handler: ToolHandler): () => void;  // returns unregister
  list(filter?: { tags?: string[]; names?: string[] }): ToolSchema[];
  invoke(name: string, args: unknown, ctx: ToolExecutionContext): Promise<unknown>;
}
```

`invoke` is the single execution entry point. It emits `tool:before-execute`, `tool:execute`, `tool:result`/`tool:error` around the handler call.

### `tool-dispatch:strategy` (`llm-native-dispatch`, `llm-codemode-dispatch`)

The bridge between LLM output and tool execution. Multiple strategies may be provided; the harness selects one by service name.

```ts
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
```

The driver's loop becomes: prepare request via strategy → call `llm:complete` → pass response to strategy → if strategy returned new messages, append and loop; else end turn.

### `driver:run-conversation` (`llm-driver`)

Exposed so `llm-agents` (and any future caller) can recursively run conversations.

```ts
export interface RunConversationInput {
  systemPrompt: string;
  messages: ChatMessage[];
  toolFilter?: { tags?: string[]; names?: string[] };  // restricts the tool registry view
  model?: string;                                       // override default model
  parentTurnId?: string;                                // for nested-turn telemetry
  signal?: AbortSignal;
}

export interface RunConversationOutput {
  finalMessage: ChatMessage;
  messages: ChatMessage[];   // full transcript including the input messages
  usage: { promptTokens: number; completionTokens: number };
}

export interface DriverService {
  runConversation(input: RunConversationInput): Promise<RunConversationOutput>;
}
```

The top-level interactive loop in the driver's `start()` is a thin wrapper over `runConversation` that pipes input from the TUI and streams output back.

### `skills:registry` (`llm-skills`)

```ts
export interface SkillManifest {
  name: string;
  description: string;
  tokens?: number;     // cached estimate for budgeting
}

export interface SkillsRegistryService {
  list(): SkillManifest[];
  load(name: string): Promise<string>;   // returns body to inject into system prompt
  register(manifest: SkillManifest, loader: () => Promise<string>): () => void;
  rescan(): Promise<void>;               // re-discover file-backed skills; used by `/skills reload`
}
```

The skills plugin also registers a `load_skill(name: string)` tool into `tools:registry` so the LLM can invoke skill loading through the normal tool path.

### `agents:registry` (`llm-agents`)

```ts
export interface AgentManifest {
  name: string;
  description: string;
  systemPrompt: string;
  toolFilter?: { tags?: string[]; names?: string[] };
}

export interface AgentsRegistryService {
  list(): AgentManifest[];
  register(manifest: AgentManifest): () => void;
}
```

The agents plugin registers a single `dispatch_agent({ name, prompt })` tool that internally calls `driver:run-conversation` with the agent's manifest.

### `slash:registry` (`llm-slash-commands`)

```ts
export interface SlashCommandManifest {
  name: string;              // without leading slash, e.g. "help"
  description: string;
  // If set, the command body is rendered with `{{args}}` substitution and
  // re-emitted as a user message. If unset, `handler` runs.
  body?: string;
  source: "builtin" | "user" | "project" | "plugin";
}

export interface SlashCommandContext {
  args: string;              // everything after the command name, single leading space stripped
  emit: (event: string, payload: unknown) => Promise<void>;
  signal: AbortSignal;
}

export interface SlashCommandHandler {
  (ctx: SlashCommandContext): Promise<void>;
}

export interface SlashRegistryService {
  register(manifest: SlashCommandManifest, handler?: SlashCommandHandler): () => void;
  list(): SlashCommandManifest[];
  // Returns true if the input matched a registered command (and was dispatched);
  // false if no match. Subscribers to `input:submit` call this to decide whether
  // to emit `input:handled`.
  tryDispatch(input: string, ctx: Omit<SlashCommandContext, "args">): Promise<boolean>;
}
```

The slash-commands plugin subscribes to `input:submit` at high priority, calls `tryDispatch`, and emits `input:handled` if it returns true. Other plugins (memory, agents, MCP-bridge) register their own slash commands by consuming this service.

## Shared types

These types are referenced by multiple service interfaces. They live in the `llm-events` plugin's `public.d.ts` so every other plugin imports from one place.

```ts
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[];      // only on assistant messages
  toolCallId?: string;         // only on tool messages
  name?: string;               // only on tool messages (the tool name)
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;          // already JSON-parsed
}

export interface ToolSchema { /* defined above */ }
export interface ModelInfo {
  id: string;
  contextLength?: number;
  description?: string;
}

// JSONSchema7 imported from `@types/json-schema`.

// Cancellation sentinel for `tool:before-execute` subscribers. Set
// `event.args = CANCEL_TOOL` to abort a tool call. The well-known
// Symbol.for() identity means subscribers don't need to import this constant.
export const CANCEL_TOOL: unique symbol = Symbol.for("kaizen.cancel");
```

## The `llm-events` plugin

The only Tier 0 implementation. Trivially small.

**Responsibilities**

1. Export `VOCAB` constant (frozen object mapping symbolic names to event-name strings).
2. Provide `llm-events:vocabulary` service whose value is `VOCAB`.
3. Call `ctx.defineEvent` for each event name in `VOCAB` so the bus knows about them.
4. Export the shared types listed above from `public.d.ts`.

**Pattern reference**

`plugins/claude-events/index.ts` — same structure, different vocabulary. The new plugin is a structural twin of the existing one.

**Permissions:** `tier: "trusted"` (matches `claude-events`).

**Tests:** unit tests covering (a) every event name in `VOCAB` is registered via `defineEvent`, (b) the `VOCAB` object is frozen, (c) the service is provided with the same reference as the export.

## Harness composition contract

Future tier specs will reference this section to declare which plugins they require. The `harnesses/openai-compatible.json` file lists plugin entries by name and version, exactly like `claude-wrapper.json`.

**A-tier harness (chat E2E):**

```
official/llm-events
official/openai-llm
official/llm-driver
official/claude-tui          (reused)
official/claude-status-items (reused)
```

**B-tier harness:** A-tier plus `llm-tools-registry`, one of `llm-native-dispatch` / `llm-codemode-dispatch`, and `llm-local-tools`.

**C-tier harness:** B-tier plus `llm-skills`, `llm-slash-commands`, `llm-memory`, `llm-agents`, `llm-mcp-bridge`, and any optional plugins selected by the user.

The default C-tier harness uses `llm-codemode-dispatch` (better reliability for local LLMs).

## Spec 0 is the source of truth — propagation rule

This document defines the contracts every dependent spec (Specs 1–12) is written against. If implementation surfaces a problem with any contract here — a missing field on `LLMStreamEvent`, a wrong return type on a service, an event payload that needs splitting — the change MUST be made here first, then propagated:

1. Edit Spec 0 to update the contract. Note the change in a `## Changelog` section at the bottom (date, what changed, why).
2. Audit every dependent spec (Specs 1–12) for sections that reference the changed contract. Update them to match. If a spec has already been turned into an implementation plan or merged code, update those too.
3. Re-run any acceptance-criteria checks in dependent specs that the contract change might invalidate.

Any plugin author or implementing agent who finds Spec 0 wrong during their work must stop and follow this propagation flow rather than diverging silently. A divergent dependent spec is a bug; the contracts in Spec 0 are authoritative.

Conversely, dependent specs MAY introduce types and interfaces internal to their own plugin without touching Spec 0 — only changes that cross plugin boundaries (event payloads, service interfaces, shared types) belong here.

## Open questions deferred to dependent specs

- HTTP/streaming details and retry semantics → Spec 1 (`openai-llm`).
- Turn-loop concurrency and cancellation semantics → Spec 2 (`llm-driver`).
- Sandbox technology choice (Bun Worker vs quickjs-emscripten) → Spec 5 (`llm-codemode-dispatch`).
- On-disk layout for skills/agents/memory → Specs 7, 9, 10.
- MCP server discovery and lifecycle → Spec 11.

## Acceptance criteria for Tier 0

- `llm-events` plugin builds, passes its own tests, and is published to the marketplace catalog.
- `public.d.ts` files for all Tier 1+ plugins can import `Vocab`, `ChatMessage`, `ToolCall`, `ToolSchema`, `LLMRequest`, `LLMResponse`, `LLMStreamEvent`, `ToolsRegistryService`, `ToolExecutionContext`, `ToolDispatchStrategy`, `DriverService`, `SkillsRegistryService`, `AgentsRegistryService`, `SlashRegistryService`, `CANCEL_TOOL` without introducing circular dependencies.
- Marketplace `entries` updated for `llm-events`.
- Tier 1 specs can be authored by reading only this document plus the existing kaizen plugin docs.

## Changelog

### 2026-04-30 — initial post-Spec-1-12 contract sync

Surfaced during parallel authoring of Specs 1–12. All entries below were flagged in the dependent specs and are now authoritative here.

- **`ToolExecutionContext.turnId`** added (Spec 10). Required for `llm-agents` to compute recursion depth and link parent/child turns.
- **`SkillsRegistryService.rescan()`** added (Spec 7). Required for the `/skills reload` slash command and any future file-watcher integration.
- **`slash:registry` service** added (Spec 8). New service, owned by `llm-slash-commands`. Lets capability plugins register slash commands without coupling to the slash-commands plugin's internals.
- **`tool:before-execute` cancellation sentinel** concretized as `CANCEL_TOOL = Symbol.for("kaizen.cancel")`, exported from `llm-events` shared types (Spec 4). Previously hand-waved as "a sentinel."
- **`llm:before-call` cancellation mechanism** concretized as `request.cancelled = true` (Spec 12). Previously implicit. Driver checks the field after all subscribers resolve.
- **`LLMRequest.cancelled?: boolean`** added to support the above.

No dependent-spec rewrites required — the dependent specs already documented the shapes above; this commit just brings Spec 0 into alignment so it remains authoritative.
