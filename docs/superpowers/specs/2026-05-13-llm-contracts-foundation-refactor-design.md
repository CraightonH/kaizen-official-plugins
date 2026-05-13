# `llm-contracts` Foundation Refactor — Design

**Date:** 2026-05-13
**Scope:** openai-compatible harness (TODO.md item #4)
**Goal:** Make every implementation plugin in the harness substitutable by inserting a different one, without changing any other plugin.

## 1. Architecture

### 1.1 Driving principle

> Any plugin providing a service consumed by another should not own the service definition. Any plugin providing a service should provide it in a way that assumes the implementation could be replaced by a new plugin.
>
> — AGENTS.md, paraphrased

The acid test the design must pass:

> Remove any implementation plugin X from the harness manifest. Replace with a stub plugin Y that imports types from `llm-contracts` and calls `provideService` for the same contract IDs. No other plugin in the harness needs to change. The harness boots, and the affected feature works (or degrades cleanly if optional).

### 1.2 The new plugin: `llm-contracts`

A pure type+declaration plugin. Zero runtime behavior. Its job:

1. `defineService(name, spec)` for every cross-plugin service contract.
2. Export every contract's TypeScript types from `public.d.ts`.
3. Be a hard dependency of every other plugin in the harness.

It does **not**: provide any service, consume any service, listen to events, register tools/skills/commands, mutate UI, or depend on any other plugin in the repo.

Internal layout:

```
llm-contracts/
  contracts/
    events.ts            # events:vocabulary
    llm-complete.ts      # llm:complete
    ui-channel.ts        # ui:channel
    ui-theme.ts          # ui:theme
    ui-status.ts         # ui:status
    ui-completion.ts     # ui:completion-source
    ui-tool-renderer.ts  # ui:tool-renderer
    tools-registry.ts    # tools:registry
    dispatch.ts          # dispatch:strategy
    sessions-store.ts    # sessions:store
    memory-store.ts      # memory:store
    skills-registry.ts   # skills:registry
    slash-registry.ts    # slash:registry
    agents-registry.ts   # agents:registry
    mcp-bridge.ts        # mcp:bridge
    prompt-registry.ts   # prompt:registry
    driver.ts            # driver:run-conversation
  index.ts               # imports each module, calls defineService; exports the KaizenPlugin descriptor
  public.d.ts            # re-exports all contract types
  package.json
  tsconfig.json
```

Each `contracts/*.ts` module is self-contained: type, contract ID constant, description string. `index.ts` imports each and calls `defineService`. `public.d.ts` re-exports all types.

### 1.3 Plugin roles

| Role | Behavior | Examples |
|---|---|---|
| **Contracts** | `defineService` + export types | `llm-contracts` (the only one) |
| **Implementation** | `provideService` for one or more contracts | `llm-tui`, `llm-driver`, `llm-skills`, `openai-llm`, etc. |
| **Consumer** | `consumeService` / `useService`; no `provideService` for any cross-plugin contract | `llm-status-items`, `llm-hooks-shell`, `llm-local-tools`, `llm-tavily-search` |

A plugin can be both implementation and consumer (most are). The forbidden case is a single plugin both *defining* and *providing* the same cross-plugin contract. `defineService` belongs to `llm-contracts`; `provideService` belongs to implementation plugins.

### 1.4 Type ownership rule

> Every cross-plugin service contract type lives in `llm-contracts/public.d.ts`. Implementation plugins **import** the type, never **define** it. A type is "cross-plugin" if any plugin other than its provider references it.

Implementation plugins keep their own `public.d.ts` for *internal* types (config shapes, plugin-private state) — just not for service contract shapes.

### 1.5 Naming convention for contract IDs

> **`<domain>:<role>`** where `<domain>` is a concept noun (never a plugin name) and `<role>` is what kind of contract it is. Both halves lowercase, kebab-case allowed. Exactly one colon. No plugin-name prefixes ever.

Domains in use: `ui`, `tools`, `dispatch`, `sessions`, `memory`, `skills`, `slash`, `agents`, `mcp`, `prompt`, `driver`, `events`, `llm`.
Roles in use: `registry`, `store`, `channel`, `theme`, `status`, `vocabulary`, `strategy`, `bridge`, `tool-renderer`, `completion-source`, `complete`, `run-conversation`.

These lists are descriptive, not exhaustive — new contracts may add domains or roles, but must follow the `<domain>:<role>` shape and the no-plugin-prefix rule.

`*:registry` is an in-process capability hub (plugins register, others query). `*:store` is a persistence layer for user/conversation data. They are distinct concepts and must not be conflated.

## 2. Contract inventory

All 17 contracts in the openai-compatible harness, with target IDs and owners.

### 2.1 Rename table

| # | Current ID | New ID | Action |
|---|---|---|---|
| 1 | `llm-events:vocabulary` | `events:vocabulary` | rename |
| 2 | `llm:complete` | `llm:complete` | keep |
| 3 | `sessions:store` | `sessions:store` | keep |
| 4 | `tools:registry` | `tools:registry` | keep |
| 5 | `prompt:system` | `prompt:registry` | rename |
| 6 | `slash:registry` | `slash:registry` | keep |
| 7 | `skills:registry` | `skills:registry` | keep |
| 8 | `memory:store` | `memory:store` | keep |
| 9 | `agents:registry` | `agents:registry` | keep |
| 10 | `mcp:bridge` | `mcp:bridge` | keep |
| 11 | `driver:run-conversation` | `driver:run-conversation` | keep |
| 12 | `tool-dispatch:strategy` | `dispatch:strategy` | rename |
| 13 | `llm-tui:channel` | `ui:channel` | rename |
| 14 | `llm-tui:completion` | `ui:completion-source` | rename |
| 15 | `llm-tui:status` | `ui:status` | rename |
| 16 | `llm-tui:theme` | `ui:theme` | rename |
| 17 | `llm-tui:tool-renderer` | `ui:tool-renderer` | rename |

### 2.2 Ownership after refactor

| Service | Defined in | Provided by |
|---|---|---|
| `events:vocabulary` | llm-contracts | llm-events |
| `llm:complete` | llm-contracts | openai-llm |
| `sessions:store` | llm-contracts | llm-session-manager |
| `tools:registry` | llm-contracts | llm-tools-registry |
| `prompt:registry` | llm-contracts | llm-system-prompt |
| `slash:registry` | llm-contracts | llm-slash-commands |
| `skills:registry` | llm-contracts | llm-skills |
| `memory:store` | llm-contracts | llm-memory |
| `agents:registry` | llm-contracts | llm-agents |
| `mcp:bridge` | llm-contracts | llm-mcp-bridge |
| `driver:run-conversation` | llm-contracts | llm-driver |
| `dispatch:strategy` | llm-contracts | llm-native-dispatch *or* llm-codemode (see §4.7) |
| `ui:channel` | llm-contracts | llm-tui |
| `ui:completion-source` | llm-contracts | llm-tui |
| `ui:status` | llm-contracts | llm-tui |
| `ui:theme` | llm-contracts | llm-tui |
| `ui:tool-renderer` | llm-contracts | llm-tui |

## 3. Per-plugin migration mechanics

### 3.1 Implementation plugins

Plugins that currently call both `defineService` and `provideService`: `llm-session-manager`, `llm-tools-registry`, `llm-system-prompt`, `llm-slash-commands`, `llm-skills`, `llm-memory`, `llm-agents`, `llm-mcp-bridge`, `llm-driver`, `llm-native-dispatch`, `llm-tui`.

Mechanical change for each:

1. Delete the `defineService` call.
2. Update the `provideService` contract ID to its new name (if renamed).
3. Replace local type definitions for the contract with imports from `llm-contracts/public`.
4. Update the `services.provides` array on the `KaizenPlugin` descriptor exported from `index.ts` to use the new ID.

> **Note:** Kaizen plugins have **no `plugin.json` file**. Plugin-level metadata
> (`name`, `apiVersion`, `permissions`, `services.provides`, `services.consumes`)
> lives inline as fields on the `KaizenPlugin` object literal exported as
> `default` from `index.ts`. Wherever this document says "`services.provides`"
> or "`services.consumes`", read it as "that field on the `KaizenPlugin`
> descriptor in `index.ts`". The plugin's `package.json` (which does exist) is
> for npm/bun package metadata only.

### 3.2 Provider-only plugins

Already aligned with the target pattern (`provideService` but not `defineService` for that contract):

- `openai-llm` — provides `llm:complete`. Update type import path only.

### 3.3 Consumer plugins

No `provideService` for any cross-plugin contract; only `consumeService` / `useService`: `llm-status-items`, `llm-hooks-shell`, `llm-local-tools`, `llm-tavily-search`.

Mechanical change:

1. Update contract IDs in `consumeService` / `useService` calls to renamed versions.
2. Update the `services.consumes` array on the `KaizenPlugin` descriptor in `index.ts`.
3. Update type imports to `llm-contracts/public`.

### 3.4 Special cases

**`llm-events`** — currently both defines and provides `events:vocabulary`, plus defines (but does not provide) `llm:complete`. Post-refactor: both definitions move to `llm-contracts`; this plugin shrinks to a provider of `events:vocabulary` only. Name stays.

**`llm-codemode`** — currently consumes `tools:registry` and `llm-tui:tool-renderer`, provides nothing. Its relationship to `dispatch:strategy` requires audit (see §4.7).

**`llm-driver`** — currently consumes `llm-tui:channel`, references `ToolDispatchStrategy` types it owns. Type definition for `ToolDispatchStrategy` moves to `llm-contracts`; consumption ID updates to `ui:channel`. Otherwise treated like any other implementation plugin (it provides `driver:run-conversation`).

## 4. Edge cases and decisions

### 4.1 Cardinality-one with multiple candidate providers (`dispatch:strategy`)

Kaizen contracts are cardinality-one. With both `llm-native-dispatch` and `llm-codemode` potentially providing `dispatch:strategy`, exactly one must be loaded per harness. Mechanism: harness-manifest selection (the user includes one or the other in `openai-compatible.json`, not both).

Decision: document the cardinality-one + mutual-exclusion rule in `llm-contracts/contracts/dispatch.ts` as a comment on the contract.

### 4.2 Marker services (`ui:status`)

Today defined as a marker service with an empty interface. Empty interface (`interface TuiStatusService {}`) moves to `llm-contracts/public` unchanged. A replacement UI that does not render a status bar simply does not provide `ui:status`; consumers use `useService("ui:status")` and check for undefined to detect presence.

### 4.3 Hard vs optional consumption

AGENTS.md mandates `consumeService` only for hard requirements; otherwise use guarded `useService`. The refactor includes a per-service audit producing a table that lives in the spec as the source of truth for `services.consumes` arrays. Likely categorizations:

- `llm-driver` → `ui:channel` — hard (driver cannot run with no UI surface).
- `llm-driver` → `dispatch:strategy` — optional (driver can fall back if no strategy is loaded; currently uses `safeUse`).
- `llm-codemode` → `ui:tool-renderer` — optional (codemode currently uses optional pattern).

This table is produced in Phase 3 and committed alongside the affected `KaizenPlugin` descriptor changes in each plugin's `index.ts`.

### 4.4 Marketplace catalog and the `llm-contracts` dependency

Kaizen plugins have no `plugin.json` file. Plugin-level metadata is declared on the `KaizenPlugin` object literal exported from `index.ts` (fields: `name`, `apiVersion`, `permissions`, `services.provides`, `services.consumes`). Plugin-level *package* metadata — name, version, exports, npm dependencies — lives in `package.json`.

The package-level dependency on `llm-contracts` is therefore expressed by adding `"llm-contracts": "workspace:*"` to each consumer/implementation plugin's `package.json` `dependencies`. There is no separate plugin-level dependency mechanism — the npm/bun workspace dependency is sufficient and is what TypeScript follows to resolve `import { ... } from "llm-contracts/public"`.

The harness manifest (`harnesses/openai-compatible.json`) lists plugins by `<marketplace>/<name>@<version>`. Those refs resolve through the marketplace catalog at `.kaizen/marketplace.json`, which maps each `name`+`version` to a source path under `plugins/`. **Adding `llm-contracts` to the harness manifest is not sufficient on its own** — a corresponding entry must also be added to `.kaizen/marketplace.json`:

```json
{
  "kind": "plugin",
  "name": "llm-contracts",
  "description": "Service contract definitions for the openai-compatible harness. Pure types + defineService; no runtime behavior.",
  "categories": ["foundation", "contracts"],
  "versions": [
    { "version": "0.1.0", "source": { "type": "file", "path": "plugins/llm-contracts" } }
  ]
}
```

This step is part of Phase 1 scaffolding.

### 4.5 Boot ordering

`llm-contracts` must load before any plugin that calls `provideService`. The harness orders plugins by manifest array position. `official/llm-contracts@x.y.z` is added as the first entry in `harnesses/openai-compatible.json`.

### 4.6 Claude-* mirror harness

`claude-driver`, `claude-events`, `claude-status-items`, `claude-tui` form a parallel harness with parallel contract IDs. Explicitly out of scope for this refactor. A future `claude-contracts` plugin could apply the same pattern.

### 4.7 `llm-codemode` role audit

Carrying forward to Phase 3. Two possible outcomes:

- (a) Codemode is an alternative `dispatch:strategy` provider that is currently mis-wired. If so, add `provideService("dispatch:strategy")` and document mutual exclusion with `llm-native-dispatch`.
- (b) Codemode is orthogonal — it registers a sandbox tool into `tools:registry` and is consumed alongside `dispatch:strategy`. If so, document the role explicitly in `llm-codemode/README.md`.

The audit task in Phase 3 picks the answer.

### 4.8 `llm-events` plugin name

Decision: keep the name. Post-refactor it is a tiny provider plugin (~20 lines) shipping the canonical `VOCAB` constant as `events:vocabulary`. "The event vocabulary plugin" is what `llm-events` already means; renaming adds churn without clarity gain.

## 5. Task decomposition

### Phase 1 — Scaffolding (1 task)

**Task: Create `llm-contracts` plugin scaffold.**

- `package.json`, `tsconfig.json`, `README.md`, `CLAUDE.md`
- `public.d.ts` empty stub
- `index.ts` exporting a `KaizenPlugin` descriptor with empty `services.provides` / `services.consumes` arrays and a `setup(ctx)` body containing no `defineService` calls yet
- `contracts/` directory with no modules yet
- Add `official/llm-contracts@0.1.0` as the first entry in `harnesses/openai-compatible.json`
- Add a corresponding `llm-contracts` entry to `.kaizen/marketplace.json` (see §4.4)

Plugin builds. Harness boots with no functional change.

### Phase 2 — Per-contract migration (17 tasks)

Task shape (one per contract):

> **Task: Migrate `<contract-id>` to `llm-contracts`**
>
> 1. Add the contract's TypeScript interface to `llm-contracts/contracts/<contract>.ts` and re-export from `llm-contracts/public.d.ts`.
> 2. Add `defineService("<new-id>", { description })` to `llm-contracts/index.ts`.
> 3. In the implementation plugin: remove its local `defineService` call; update `provideService` to the new ID (if renamed); replace the local type definition with `import` from `llm-contracts/public`.
> 4. In every consumer plugin: rename `consumeService` / `useService` calls to the new ID; replace the local type import with one from `llm-contracts/public`.
> 5. Update `services.provides` / `services.consumes` arrays on the `KaizenPlugin` descriptor in every affected plugin's `index.ts`.
> 6. Run the substitutability acid test: temporarily stub-replace the provider, confirm the harness boots and consumers function or degrade as documented.
> 7. Commit as a single atomic change.

Each migration is atomic per contract — two plugins calling `defineService` for the same ID at boot is a contract violation.

Execution order (sensible, not strictly required):

1. `events:vocabulary` (rename)
2. `llm:complete` (keep)
3. `sessions:store` (keep)
4. `tools:registry` (keep)
5. `prompt:registry` (rename)
6. `slash:registry` (keep)
7. `skills:registry` (keep)
8. `memory:store` (keep)
9. `agents:registry` (keep)
10. `mcp:bridge` (keep)
11. `dispatch:strategy` (rename)
12. `ui:channel` (rename)
13. `ui:theme` (rename)
14. `ui:status` (rename)
15. `ui:completion-source` (rename)
16. `ui:tool-renderer` (rename)
17. `driver:run-conversation` (keep)

Driver is last because it touches the most types and confirms the foundation is correctly settled.

### Phase 3 — Audits and cleanup (3 tasks)

- **Task: `llm-codemode` role audit.** Determine whether codemode should provide `dispatch:strategy` (option a) or remain orthogonal (option b). Apply the appropriate change.
- **Task: Hard-vs-optional consumption audit.** Walk every `consumeService` / `useService` edge in the harness; categorize each as hard or optional per AGENTS.md; adjust calls so hard deps use `consumeService` and optional ones use guarded `useService`. Commit the table to this spec.
- **Task: Documentation sweep.** Update each affected plugin's `README.md` and `CLAUDE.md` to reference the new contract IDs and import paths. Author `llm-contracts/README.md` explaining the contract-plugin pattern.

### Phase 4 — End-to-end verification (1 task)

**Task: Full-harness substitutability verification.**

For each implementation plugin, create a throwaway stub plugin in a test fixture that satisfies the same contracts. Boot the harness with the stub swapped in. Confirm no other plugin requires modification. Tear down stubs.

### Totals

**22 discrete tasks.** Phase 1 unblocks Phase 2. Phase 2 tasks are independent of each other and can run in parallel if desired. Phases 3 and 4 require Phase 2 complete.

## 6. Out of scope

- `claude-*` mirror harness refactor (future work).
- New providers for any existing contract (the spec enables them, doesn't add them).
- Cardinality-N service registry contracts (only mentioned as a future extension if a feature ever needs multiple simultaneous providers for one role).
- New plugin-level dependency mechanism (not needed — npm/bun workspace deps suffice; see §4.4).

## 7. Success criteria

- `llm-contracts` exists and is the sole `defineService` site for all 17 listed contracts.
- Every implementation plugin imports its contract types from `llm-contracts/public`.
- Every implementation plugin's `provideService` call uses the new contract ID.
- Every consumer plugin's `consumeService` / `useService` call uses the new contract ID.
- Every affected plugin's `KaizenPlugin` descriptor (in `index.ts`) has `services.provides` / `services.consumes` arrays in lockstep with the runtime `defineService` / `provideService` / `consumeService` calls.
- `.kaizen/marketplace.json` contains an `llm-contracts` entry resolving to `plugins/llm-contracts`.
- The substitutability acid test passes for every implementation plugin (verified in Phase 4).
- `openai-compatible.json` lists `llm-contracts` first and boots cleanly.
- AGENTS.md review checklist passes for each contract.
