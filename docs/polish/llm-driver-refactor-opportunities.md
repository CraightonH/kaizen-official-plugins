# llm-driver Refactor Opportunities

Date: 2026-05-11
Session target: llm-driver

## Opportunity

The `driver:run-conversation` public contract is duplicated in `llm-driver/public.d.ts` and `llm-events/public.d.ts`.

## Evidence

- Files/functions involved: `plugins/llm-driver/public.d.ts`, `plugins/llm-events/public.d.ts`, and consumers that import `RunConversationInput` from `llm-events/public`.
- Concrete symptoms: `llm-driver` already allowed owned runs without `userMessage` for `session:handoff` seeded tails, while the shared `llm-events/public` type still required `userMessage`.
- Existing tests that make the issue visible: `plugins/llm-driver/test/loop.test.ts` covers omitted `userMessage`; `plugins/llm-events/index.test.ts` now covers the shared type accepting the same shape.

## Scope

- Local to this plugin or cross-plugin: cross-plugin.
- Affected openai-compatible plugins: `llm-driver`, `llm-events`, `llm-agents`, `llm-slash-commands`, and any plugin importing `DriverService` or `RunConversationInput`.
- Related contracts: `driver:run-conversation` service, `ChatMessage`, and `TurnHandle`.

## Suggested Direction

- Keep one source of truth for `DriverService`, `RunConversationInput`, and `RunConversationOutput`.
- Either have `llm-driver/public.d.ts` import the shared contract from `llm-events/public`, or move the driver contract entirely behind `llm-driver/public` and update consumers to import it from the owning plugin.
- Add a type-level compatibility test if both exports must remain for compatibility.

## Not Done In This Session

This session only aligned the mismatched shapes. Changing import ownership would touch multiple plugins and should be sequenced separately from this bounded driver polish pass.
