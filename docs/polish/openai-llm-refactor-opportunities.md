# openai-llm Refactor Opportunities

Date: 2026-05-12
Session target: openai-llm

## Opportunity

`openai-llm` is meant to be one swappable provider implementation, but the
runtime `llm:complete` service definition still lives inside this concrete
provider. That makes the provider look like the owner of the Kaizen-side LLM
interface even though the shared request/response types are owned by
`llm-events/public`.

## Evidence

- Files/functions involved:
  - `plugins/openai-llm/index.ts` calls both `ctx.defineService("llm:complete",
    ...)` and `ctx.provideService("llm:complete", ...)`.
  - `plugins/llm-events/public.d.ts` owns `LLMCompleteService`, `LLMRequest`,
    `LLMResponse`, `LLMStreamEvent`, and `ModelInfo`.
  - `plugins/llm-driver/index.ts` and `plugins/llm-status-items/index.ts`
    consume `llm:complete` as a provider-neutral service.
- Concrete symptoms:
  - Future `anthropic-llm`, `chatgpt-llm`, or other provider plugins would need
    to repeat the same `llm:complete` service definition.
  - Loading more than one provider at once has no explicit provider-selection
    contract.
  - A provider-local `public.d.ts` re-export made this plugin look like a type
    contract owner; this session removed that unexported local surface.
- Existing tests that make the issue visible:
  - `plugins/openai-llm/index.test.ts` now locks the current compatibility
    behavior: the provider still defines and provides `llm:complete`.

## Scope

- Local to this plugin or cross-plugin: cross-plugin.
- Affected openai-compatible plugins:
  - `llm-events`: likely neutral owner for the provider contract and service
    definition, unless a new `llm-provider-contract` plugin is introduced.
  - `openai-llm`: should eventually provide only the implementation.
  - `llm-driver`: consumes the provider-neutral service.
  - `llm-status-items`: consumes `llm:complete.listModels()`.
  - Future provider plugins: should implement the same interface without
    owning it.
- Related contracts:
  - Service name: `llm:complete`.
  - Types: `LLMCompleteService`, `LLMRequest`, `LLMResponse`,
    `LLMStreamEvent`, `ModelInfo`.

## Suggested Direction

- Move `ctx.defineService("llm:complete", ...)` to a neutral owner, probably
  `llm-events` if foundation-level service definitions are acceptable there.
- Keep provider plugins responsible for `ctx.provideService("llm:complete",
  impl)` only.
- Keep all consumers importing provider-neutral types from `llm-events/public`.
- Decide provider-selection semantics before supporting more than one loaded
  provider at a time. A single active provider may be enough for the current
  harness; multi-provider loading likely needs a separate selector or namespaced
  provider registry.
- Update harness tests to verify that the neutral definition is registered
  before the provider implementation binds.

## Not Done In This Session

Changing runtime ownership affects the foundation plugin and every harness that
loads an LLM provider. This polish pass kept runtime behavior compatible while
removing the misleading provider-local public type surface and documenting the
needed cross-plugin migration.
