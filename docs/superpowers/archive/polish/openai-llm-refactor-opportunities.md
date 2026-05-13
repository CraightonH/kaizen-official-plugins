# openai-llm Refactor Opportunities

Date: 2026-05-12
Session target: openai-llm
Status: Implemented for runtime `llm:complete` ownership on 2026-05-12.

## Opportunity

`openai-llm` is meant to be one swappable provider implementation. The runtime
`llm:complete` service definition now lives in `llm-events`, matching the shared
request/response types in `llm-events/public`.

The remaining design question is provider selection when more than one provider
plugin is loaded at the same time.

## Evidence

- Files/functions involved:
  - `plugins/llm-events/index.ts` calls `ctx.defineService("llm:complete", ...)`.
  - `plugins/openai-llm/index.ts` calls
    `ctx.provideService("llm:complete", ...)` only.
  - `plugins/llm-events/public.d.ts` owns `LLMCompleteService`, `LLMRequest`,
    `LLMResponse`, `LLMStreamEvent`, and `ModelInfo`.
  - `plugins/llm-driver/index.ts` and `plugins/llm-status-items/index.ts`
    consume `llm:complete` as a provider-neutral service.
- Concrete symptoms:
  - Loading more than one provider at once has no explicit provider-selection
    contract.
- Existing tests that make the issue visible:
  - `plugins/llm-events/index.test.ts` locks the neutral service definition.
  - `plugins/openai-llm/index.test.ts` locks that the provider does not define
    the service it provides.

## Scope

- Local to this plugin or cross-plugin: cross-plugin.
- Affected openai-compatible plugins:
  - `llm-events`: likely neutral owner for the provider contract and service
    definition, unless a new `llm-provider-contract` plugin is introduced.
  - `openai-llm`: provides only the implementation.
  - `llm-driver`: consumes the provider-neutral service.
  - `llm-status-items`: consumes `llm:complete.listModels()`.
  - Future provider plugins: should implement the same interface without
    owning it.
- Related contracts:
  - Service name: `llm:complete`.
  - Types: `LLMCompleteService`, `LLMRequest`, `LLMResponse`,
    `LLMStreamEvent`, `ModelInfo`.

## Suggested Direction

- Keep provider plugins responsible for `ctx.provideService("llm:complete",
  impl)` only.
- Keep all consumers importing provider-neutral types from `llm-events/public`.
- Decide provider-selection semantics before supporting more than one loaded
  provider at a time. A single active provider may be enough for the current
  harness; multi-provider loading likely needs a separate selector or namespaced
  provider registry.

## Not Done In This Session

Provider selection for multiple simultaneous LLM providers remains unresolved.
The current service registry is cardinality-one, so only one plugin can provide
`llm:complete` in a harness.
