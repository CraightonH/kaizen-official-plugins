# llm-events

Tier 0 foundation plugin for the local Kaizen harness.

## What it provides

- **`events:vocabulary` service** — a frozen `VOCAB` object mapping every
  Spec 0 event symbolic name (e.g. `LLM_BEFORE_CALL`) to its wire string
  (`"llm:before-call"`). Subscribers should always import this constant rather
  than hand-typing event-name strings.
- **`ctx.defineEvent` registration** for every name in `VOCAB`, so the bus
  validates `emit`/`on` calls against the known set.

## Non-contract public surface

`public.d.ts` re-exports the runtime sentinel `CANCEL_TOOL` and
`CODEMODE_CANCEL_SENTINEL`. All cross-plugin contract types — `ChatMessage`,
`ToolCall`, `ToolSchema`, `ModelInfo`, `LLMRequest`, `LLMResponse`,
`LLMStreamEvent`, `LLMCompleteService`, `Vocab` — live in `llm-contracts/public`
and should be imported from there.

`VOCAB` is the runtime constant (implementation value) shipped by this plugin;
the `Vocab` type is the contract type in `llm-contracts/public`.

## Service contract ownership

All 17 cross-plugin service contracts — including `events:vocabulary` and
`llm:complete` — are defined in `llm-contracts`, not here. `llm-events` is a
provider of `events:vocabulary` only; it does not call `defineService`.

Do not add contract definitions or cross-plugin type declarations to this
plugin. Types needed by other plugins belong in `llm-contracts/public`.

## Permissions

`tier: "trusted"` — matches `claude-events`.
