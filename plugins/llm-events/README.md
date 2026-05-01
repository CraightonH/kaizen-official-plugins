# llm-events

Tier 0 foundation plugin for the openai-compatible Kaizen harness.

## What it provides

- **`llm-events:vocabulary` service** — a frozen `VOCAB` object mapping every
  Spec 0 event symbolic name (e.g. `LLM_BEFORE_CALL`) to its wire string
  (`"llm:before-call"`). Subscribers should always import this constant rather
  than hand-typing event-name strings.
- **`ctx.defineEvent` registration** for every name in `VOCAB`, so the bus
  validates `emit`/`on` calls against the known set.
- **Shared types** in `public.d.ts`. Every other `llm-*` plugin in the harness
  imports cross-plugin contracts from here to avoid circular dependencies.

## Type re-exports (cross-plugin contracts)

`public.d.ts` is the single import point for:

- Conversation primitives — `ChatMessage`, `ToolCall`, `ToolSchema`,
  `ModelInfo`, `LLMRequest`, `LLMResponse`, `LLMStreamEvent`,
  `LLMCompleteService`.
- Cancellation sentinel — `CANCEL_TOOL = Symbol.for("kaizen.cancel")`.
- Service interfaces (declared here, *implemented* by their owning plugin):
  `ToolsRegistryService`, `ToolHandler`, `ToolExecutionContext`,
  `ToolDispatchStrategy`, `DriverService`, `RunConversationInput`,
  `RunConversationOutput`, `SkillsRegistryService`, `SkillManifest`,
  `AgentsRegistryService`, `AgentManifest`, `SlashRegistryService`,
  `SlashCommandManifest`, `SlashCommandHandler`, `SlashCommandContext`,
  `TuiCompletionService`, `CompletionSource`, `CompletionItem`.

## Why interfaces live here, not in their owning plugin

Spec 0 is the propagation source-of-truth for any cross-plugin contract.
Hosting service-interface declarations in `llm-events` keeps the dependency
graph acyclic: every `llm-*` plugin depends on `llm-events`, and `llm-events`
depends on nothing. An owning plugin (e.g. `llm-driver` for `DriverService`)
implements the interface and `provideService`s a value satisfying its shape.

## Permissions

`tier: "trusted"` — matches `claude-events`.
