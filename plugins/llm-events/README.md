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
  conversation, and LLM primitives from here. Service-specific contracts are
  moving to their owning plugin's `public` surface; compatibility exports remain
  here during that migration.

## Type re-exports (cross-plugin contracts)

`public.d.ts` is the stable import point for:

- Conversation primitives — `ChatMessage`, `ToolCall`, `ToolSchema`,
  `ModelInfo`, `LLMRequest`, `LLMResponse`, `LLMStreamEvent`,
  `LLMCompleteService`.
- Cancellation sentinels — `CANCEL_TOOL = Symbol.for("kaizen.cancel")` and
  `CODEMODE_CANCEL_SENTINEL = "__kaizen_cancel__"`.
- Deprecated compatibility service interfaces — tool registry, skills, agents,
  slash registry, TUI completion, and dispatch strategy contracts remain
  available here temporarily, but new consumers should import each service
  contract from the plugin that provides that service.

## Service contract ownership

`llm-events` owns event vocabulary and foundation LLM primitives. New
service-specific interfaces belong with the plugin that owns the service
behavior, for example `driver:run-conversation` in `llm-driver/public` and
`tools:registry` in `llm-tools-registry/public`.

The older aggregate exports in `llm-events/public.d.ts` are compatibility
exports while the openai-compatible plugins migrate one service surface at a
time. Do not add new service contracts here unless the contract is deliberately
foundation-level and has no higher-level owner.

## Permissions

`tier: "trusted"` — matches `claude-events`.
