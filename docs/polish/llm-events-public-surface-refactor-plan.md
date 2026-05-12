# llm-events Public Surface Refactor Plan

Date: 2026-05-12
Related note: `docs/polish/llm-events-refactor-opportunities.md`

## Goal

Move service-specific public interfaces out of `llm-events/public.d.ts` and
into the plugin that owns the service behavior. Leave `llm-events` responsible
for the event vocabulary and foundation LLM primitives only.

This is a type-surface and import-ownership refactor. It should not change
runtime behavior, event names, service names, harness order, or emitted payloads.

## Motivation

`llm-events/public.d.ts` currently aggregates declarations for several services
implemented elsewhere. That made the dependency graph simple, but it also
created drift: owner plugins changed their service shapes while the foundation
declarations stayed stale.

The desired shape is:

- A plugin owns the public interface for services it provides.
- `llm-events` owns only shared primitives that do not belong to a higher-level
  provider.
- Consumers import service contracts from the provider plugin whose service
  they consume.

## Final Ownership Model

Keep in `llm-events/public.d.ts`:

- `Vocab`, `EventName`
- `ChatMessage`, `ToolCall`, `ToolSchema`
- `ModelInfo`, `LLMRequest`, `LLMResponse`, `LLMStreamEvent`
- event-level sentinels that require stable cross-plugin identity, unless a
  later session explicitly moves them with a compatibility re-export

Move to owning plugin public surfaces:

- `ToolsRegistryService`, `ToolHandler`, `ToolExecutionContext`, `ToolSource`,
  `ToolRegistration` -> `llm-tools-registry/public`
- `SkillsRegistryService`, `SkillManifest`, `SkillRescanResult` ->
  `llm-skills/public`
- `AgentsRegistryService`, `AgentManifest` -> `llm-agents/public`
- `SlashRegistryService`, `SlashCommandManifest`, `SlashCommandContext`,
  `SlashCommandHandler`, `SlashRegistryEntry` -> `llm-slash-commands/public`
- `CompletionItem`, `CompletionSource`, `TuiCompletionService` ->
  `llm-tui/public`

Already owner-local and should stay owner-local:

- `DriverService`, `RunConversationInput`, `RunConversationOutput` ->
  `llm-driver/public`
- `SystemPromptService`, `SystemPromptSection`, `RegisteredSection` ->
  `llm-system-prompt/public`
- `SessionsStoreService`, `SessionRecord`, `TurnHandle` ->
  `llm-session-manager/public`
- `McpBridgeService`, `ServerInfo` -> `llm-mcp-bridge/public`
- `MemoryStoreService`, `MemoryEntry` -> `llm-memory/public`

Decision points to handle deliberately:

- `LLMCompleteService`: this is a generic `llm:complete` provider contract, not
  specifically OpenAI-owned. Recommendation: leave it in `llm-events` until
  there is a neutral provider-contract owner or multiple provider plugins need
  a shared non-events package.
- `ToolDispatchStrategy`: the current provider is `llm-native-dispatch`, but
  the driver consumes the strategy and future dispatch plugins may exist.
  Recommendation: decide in the dispatch migration session whether the contract
  belongs in `llm-native-dispatch/public`, `llm-driver/public`, or a future
  neutral dispatch-contract package. Do not move it opportunistically.
- `CANCEL_TOOL`: the behavior is tool-registry-owned, but the symbol identity is
  intentionally cross-plugin. Recommendation: keep the runtime export from
  `llm-events` during the migration. Do not expose it from
  `llm-tools-registry/public` while that subpath is type-only; revisit only if
  the owner package gains a runtime public module.

## Compatibility Strategy

Use a two-step migration for each owner surface:

1. Add or complete the owner-local public declarations.
2. Update consumers to import service contracts from the owner.
3. Keep temporary deprecated re-exports in `llm-events/public.d.ts` until the
   repository has no consumers left.
4. Remove deprecated service re-exports from `llm-events` in a final breaking
   cleanup session.

This keeps each session small and prevents one broad import rewrite from
touching every plugin at once.

When a consumer starts importing a type from a provider plugin, update that
consumer's `package.json` dependencies if the package does not already name the
provider. Type-only imports are erased at runtime, but tests, editors, and
packaging still need the dependency to resolve.

## Session Plan

### Session 1: Policy and Deprecation Markers

Scope:

- Add comments in `llm-events/public.d.ts` marking service-specific exports as
  deprecated compatibility exports.
- Update `plugins/llm-events/README.md` and `CLAUDE.md` to state that new
  service interfaces belong with the service owner.
- Add tests that keep the primitives importable from `llm-events/public`.
- Do not move imports yet.

Validation:

- `bun test plugins/llm-events`
- `plugins/llm-events/node_modules/.bin/tsc -p plugins/llm-events/tsconfig.json`
- `bunx kaizen plugin validate plugins/llm-events`

### Session 2: Move `tools:registry` Types to Owner Imports

Scope:

- Make `llm-tools-registry/public.d.ts` the canonical source for
  `ToolsRegistryService`, `ToolHandler`, `ToolExecutionContext`, `ToolSource`,
  and `ToolRegistration`.
- Update consumers of these service types to import from
  `llm-tools-registry/public`.
- Leave `ToolSchema`, `ToolCall`, `ChatMessage`, and the `CANCEL_TOOL` runtime
  value available from `llm-events`.

Likely affected plugins:

- `llm-agents`
- `llm-skills`
- `llm-codemode`
- `llm-mcp-bridge`
- `llm-native-dispatch`
- tests that currently use `ToolsRegistryService` from `llm-events/public`

Validation:

- `bun test plugins/llm-tools-registry`
- `bun test plugins/llm-agents plugins/llm-skills plugins/llm-codemode plugins/llm-mcp-bridge plugins/llm-native-dispatch`
- `rg 'ToolsRegistryService|ToolHandler|ToolExecutionContext|ToolRegistration|ToolSource' plugins -g '*.ts' -g '*.d.ts'`
  and verify remaining `llm-events/public` imports are only compatibility tests
  or primitives.

### Session 3: Move `skills:registry` and `agents:registry` Types

Scope:

- Make `llm-skills/public.d.ts` own `SkillManifest`,
  `SkillsRegistryService`, and `SkillRescanResult`.
- Make `llm-agents/public.d.ts` own `AgentManifest` and
  `AgentsRegistryService`.
- Update source and tests in both plugins and any cross-plugin consumers.

Likely affected plugins:

- `llm-skills`
- `llm-agents`
- tests that construct skill or agent manifests

Validation:

- `bun test plugins/llm-skills plugins/llm-agents`
- Targeted grep for `SkillManifest`, `SkillsRegistryService`,
  `AgentManifest`, and `AgentsRegistryService` imports from
  `llm-events/public`.

### Session 4: Move `slash:registry` Types

Scope:

- Make `llm-slash-commands/public.d.ts` the canonical source for
  `SlashRegistryService`, `SlashCommandManifest`, `SlashCommandContext`,
  `SlashCommandHandler`, and `SlashRegistryEntry`.
- Update plugins that softly register slash commands to import types from
  `llm-slash-commands/public` where they use concrete slash types.
- Keep local `*Like` adapter interfaces when a plugin intentionally wants a
  narrow optional-service shape and does not need the full owner contract.

Likely affected plugins:

- `llm-tools-registry`
- `llm-session-manager`
- `llm-status-items`
- `llm-mcp-bridge`
- `llm-system-prompt`

Validation:

- `bun test plugins/llm-slash-commands`
- `bun test plugins/llm-tools-registry plugins/llm-session-manager plugins/llm-status-items plugins/llm-mcp-bridge plugins/llm-system-prompt`
- Grep for slash types imported from `llm-events/public`.

### Session 5: Move TUI Completion Types

Scope:

- Make `llm-tui/public.d.ts` the canonical source for `CompletionItem`,
  `CompletionSource`, and `TuiCompletionService`.
- Update completion producers to import from `llm-tui/public` when they depend
  on that service.
- Leave transcript/channel/status/theme types owner-local in `llm-tui/public`.

Likely affected plugins:

- `llm-slash-commands`
- tests around completion registration

Validation:

- `bun test plugins/llm-tui plugins/llm-slash-commands`
- Grep for completion service types imported from `llm-events/public`.

### Session 6: Resolve Dispatch and Provider Contract Ownership

Scope:

- Decide the owner for `ToolDispatchStrategy`.
- Decide whether `LLMCompleteService` remains a foundation primitive or needs a
  new owner.
- Apply only the decisions made in this session. Avoid also removing deprecated
  exports from `llm-events`.

Validation:

- `bun test plugins/llm-driver plugins/llm-native-dispatch plugins/openai-llm`
- `bun test plugins/llm-events`
- Any additional consumer tests for plugins that use driver/provider services.

### Session 7: Remove Deprecated Service Exports from `llm-events`

Prerequisites:

- Grep shows no production plugin imports moved service contracts from
  `llm-events/public`.
- Owner public surfaces exist and are documented.
- Compatibility docs identify migration paths.

Scope:

- Remove service-specific declarations from `llm-events/public.d.ts`.
- Keep foundation primitives and agreed foundation services only.
- Update `llm-events` tests to assert the narrower public surface.
- Bump `llm-events` version and update `.kaizen/marketplace.json` plus
  `harnesses/openai-compatible.json`.
- Create or update a contract-change doc because this is the breaking cleanup.

Validation:

- `bun test plugins/llm-events`
- `bun test`
- `bunx kaizen plugin validate plugins/llm-events`
- `bunx kaizen marketplace validate`

## Acceptance Criteria

- `llm-events/public.d.ts` no longer declares owner-specific service contracts.
- Service owners expose their own public interfaces through package subpaths.
- Consumers import service contracts from the service owner.
- Foundation primitives remain importable from `llm-events/public`.
- The openai-compatible harness still validates and the full local test suite
  passes.
- Any remaining compatibility re-exports are intentional, documented, and
  scheduled for removal.

## Risks

- Type-only imports can still require workspace dependencies for tests and
  editors. Each migration session should update `package.json` dependencies
  where needed.
- Optional services can become conceptually coupled if consumers import a
  provider plugin only for types. Prefer narrow local `*Like` interfaces when a
  plugin only needs a small optional-service subset.
- Moving too many contracts in one session will make review hard. Keep one
  owner surface per session unless the affected set is tiny.
- Removing `llm-events` compatibility exports before all consumers migrate will
  create avoidable breakage.
