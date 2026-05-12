# llm-events

Tier 0 foundation plugin for the openai-compatible Kaizen harness.

## What it provides

- **`llm-events:vocabulary` service** — a frozen `VOCAB` object mapping every
  Spec 0 event symbolic name (e.g. `LLM_BEFORE_CALL`) to its wire string
  (`"llm:before-call"`). Subscribers should always import this constant rather
  than hand-typing event-name strings.
- **`ctx.defineEvent` registration** for every name in `VOCAB`, so the bus
  validates `emit`/`on` calls against the known set.
- **Foundation types** in `public.d.ts`. Other `llm-*` plugins import event,
  conversation, tool schema/call, and LLM provider primitives from here.

## Type re-exports (cross-plugin contracts)

`public.d.ts` is the stable import point for:

- Conversation primitives — `ChatMessage`, `ToolCall`, `ToolSchema`,
  `ModelInfo`, `LLMRequest`, `LLMResponse`, `LLMStreamEvent`,
  `LLMCompleteService`.
- Runtime sentinels — `CANCEL_TOOL = Symbol.for("kaizen.cancel")` and
  `CODEMODE_CANCEL_SENTINEL = "__kaizen_cancel__"`.

Service-specific contracts are intentionally not exported from `llm-events`.
Import them from the plugin that owns the service behavior, such as
`llm-tools-registry/public`, `llm-driver/public`, `llm-skills/public`,
`llm-agents/public`, `llm-slash-commands/public`, or `llm-tui/public`.

## Service contract ownership

`llm-events` owns event vocabulary and foundation LLM primitives. New
service-specific interfaces belong with the plugin that owns the service
behavior, for example `driver:run-conversation` in `llm-driver/public` and
`tools:registry` in `llm-tools-registry/public`.

Do not add service contracts here unless the contract is deliberately
foundation-level and has no higher-level owner.

## Permissions

`tier: "trusted"` — matches `claude-events`.
