# llm-events

Tier 0 foundation plugin for the openai-compatible Kaizen harness.

## What it provides

- **`llm-events:vocabulary` service** — a frozen `VOCAB` object mapping every
  Spec 0 event symbolic name (e.g. `LLM_BEFORE_CALL`) to its wire string
  (`"llm:before-call"`). Subscribers should always import this constant rather
  than hand-typing event-name strings.
- **`ctx.defineEvent` registration** for every name in `VOCAB`, so the bus
  validates `emit`/`on` calls against the known set.
- **Shared types** in `public.d.ts`. Other `llm-*` plugins import event,
  conversation, LLM, tool, slash, status, skill, and agent contracts from here.
  Owner-specific contracts that depend on higher-level plugins live with their
  owning plugin, for example `driver:run-conversation` in `llm-driver/public`.

## Type re-exports (cross-plugin contracts)

`public.d.ts` is the single import point for:

- Conversation primitives — `ChatMessage`, `ToolCall`, `ToolSchema`,
  `ModelInfo`, `LLMRequest`, `LLMResponse`, `LLMStreamEvent`,
  `LLMCompleteService`.
- Cancellation sentinel — `CANCEL_TOOL = Symbol.for("kaizen.cancel")`.
- Service interfaces (declared here, *implemented* by their owning plugin):
  `ToolsRegistryService`, `ToolHandler`, `ToolExecutionContext`,
  `ToolDispatchStrategy`, `SkillsRegistryService`, `SkillManifest`,
  `AgentsRegistryService`, `AgentManifest`, `SlashRegistryService`,
  `SlashCommandManifest`, `SlashCommandHandler`, `SlashCommandContext`,
  `TuiCompletionService`, `CompletionSource`, `CompletionItem`.
- Driver service interfaces — `DriverService`, `RunConversationInput`, and
  `RunConversationOutput` — are owned by `llm-driver/public`.

## Why interfaces live here, not in their owning plugin

Spec 0 is the propagation source-of-truth for foundational cross-plugin
contracts. Hosting shared declarations in `llm-events` keeps the dependency
graph acyclic: every `llm-*` plugin can depend on `llm-events`, and
`llm-events` depends on nothing. Contracts that need types from a higher-level
plugin stay with their owner so this foundation plugin remains a leaf.

## Permissions

`tier: "trusted"` — matches `claude-events`.
