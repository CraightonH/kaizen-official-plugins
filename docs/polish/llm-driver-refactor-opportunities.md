# llm-driver Refactor Opportunities

Date: 2026-05-13
Session target: llm-agents / llm-native-dispatch follow-up

## Opportunity 1 — `RunConversationInput.systemPrompt` is silently ignored when `prompt:system` is present

When `llm-driver`'s `resolveSystemPrompt()` finds a `prompt:system` service, it
returns the globally-assembled prompt and ignores `input.systemPrompt`. This
means a `dispatch_agent` call that passes the agent persona via
`RunConversationInput.systemPrompt` does not deliver that persona to the LLM:
the sub-agent runs with the parent harness's assembled system prompt instead.

### Evidence

- `plugins/llm-driver/loop.ts` — `resolveSystemPrompt()` (around L64–L73).
- `plugins/llm-agents/dispatch.ts` — passes `internal.systemPrompt` into
  `RunConversationInput.systemPrompt` (around L117).
- Existing tests still pass because the test harness builds
  `RunConversationInput` directly and does not go through the driver's
  `promptSystem` branch.

### Scope

- Cross-plugin: behavior owner is `llm-driver`; affected consumer is
  `llm-agents` (and any future caller that wants a per-call system prompt
  override).
- Related contracts: `driver:run-conversation`, `prompt:system`.

### Suggested direction

Either:

1. **Per-call override wins.** `resolveSystemPrompt` uses
   `input.systemPrompt` verbatim when set, falling back to
   `promptSystem.assemble()` only when absent. Simplest; matches the existing
   shape of `RunConversationInput.systemPrompt`.
2. **Per-call scope on `prompt:system`.** Add a scope argument so the agent
   dispatch can request a clean sub-agent assembly. More work, more powerful;
   useful if agents need to compose their persona with shared sections.

Sequencing: option (1) is a one-line behavior change in `loop.ts` plus a test
locking the override. Option (2) is a bigger contract change owned by
`llm-system-prompt` and needs its own contract-change doc.

### Risks

- Any caller relying on the implicit "prompt:system always wins" behavior would
  see a behavior change. Audit `llm-events` event payloads emitted around
  system-prompt resolution; if any consumer logs or branches on a stable
  globally-assembled prompt, surface it before flipping the default.

### Not done in this session

This is a behavior change to a polished plugin and benefits from a focused
session that locks the new contract with tests and updates the
`driver:run-conversation` documentation. The current polish pass for `llm-agents`
intentionally only narrowed `services.consumes` and added an idempotent
`stop()`; flipping the system-prompt override is out of scope.

## Opportunity 2 — `services.consumes` accuracy across the harness

Multiple plugins declare `services.consumes` entries for services they never
hard-require (resolved via `useService` with a degraded path), in tension with
AGENTS.md §"Required vs Optional Dependencies": *"Use `services.consumes` and
`ctx.consumeService()` only for hard requirements."*

The current rationale is that `services.consumes` is the only signal the
kaizen platform's topo-sort uses today, so plugins that need ordering for
late-bound `useService` calls keep the consume edge as a "documentary" edge.

### Evidence

- `llm-skills/index.ts` — declares `consumes: ["tools:registry", "prompt:system"]`
  but treats `tools:registry` as optional.
- `llm-native-dispatch/index.ts` — declares `consumes: ["tools:registry",
  "llm-events:vocabulary"]` while the strategy itself never calls
  `useService`/`consumeService` for either (registry is parameter-injected by
  the driver; vocabulary is just an emit string).
- `llm-memory/index.ts` — the recent polish narrowed to
  `consumes: ["llm-events:vocabulary"]` only. This is the only plugin that
  strictly follows AGENTS.md.

### Scope

- Ecosystem-level. Either the kaizen platform grows a `softConsumes` (or
  `loadOrder`) primitive that participates in topo-sort without implying
  hard-require semantics, or AGENTS.md is amended to say "consumes may be used
  as a topo-sort-only edge when the documented degradation path is taken".

### Suggested direction

- Decide which convention the harness should follow and apply it uniformly.
- If platform support is added, sweep all plugins to remove documentary
  `consumes` entries.

### Not done in this session

Cross-plugin policy decision; needs platform input before flipping any plugin
manifests.
