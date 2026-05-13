# llm-contracts

The contract foundation for the openai-compatible Kaizen harness. This plugin
defines every cross-plugin service contract and exports their TypeScript types.
It has zero runtime behavior — no `provideService` calls, no event
subscriptions, no UI mutation.

## Why this exists

### The substitutability problem

Service contracts are the integration surface between plugins. If a contract is
defined inside the plugin that also provides it, replacing that plugin with a
different implementation simultaneously removes the contract definition — every
consumer of that contract breaks. The contract should outlive any particular
provider.

By centralizing all definitions here, any implementation plugin in the harness
can be replaced by a substitute that imports the same types from
`llm-contracts/public` and calls `provideService` with the same contract ID. No
other plugin in the harness needs to change.

### Contract definition vs. implementation

This plugin only calls `ctx.defineService` — it never calls `ctx.provideService`.
Implementation plugins call `provideService` but must not call `defineService`.
The contract definition lives here; the implementation lives in the owning plugin.

| Role | What it does | Example plugins |
|---|---|---|
| **Contracts** | `defineService` + export types | `llm-contracts` (the only one) |
| **Implementation** | `provideService` for one or more contracts | `llm-tui`, `llm-driver`, `llm-events` |
| **Consumer** | `consumeService` / `useService`; no `provideService` for cross-plugin contracts | `llm-status-items`, `llm-hooks-shell` |

## What's inside

```
contracts/<topic>.ts   One file per contract. Contains the TypeScript interface(s),
                       the CONTRACT_ID constant, and the DESCRIPTION string.
index.ts               Calls ctx.defineService for every contract at plugin setup.
                       Exports the KaizenPlugin descriptor.
public.ts              Re-exports every contract type for consumers and providers
                       to import. NOTE: .ts not .d.ts — this file also exports the
                       runtime value CANCEL_TOOL from the tools-registry contract.
```

## The 17 contracts

| Contract ID | Description | Defined in | Provided by |
|---|---|---|---|
| `events:vocabulary` | Frozen VOCAB mapping symbolic names to wire-string event names | `contracts/events.ts` | `llm-events` |
| `llm:complete` | Provider-neutral LLM streaming completion | `contracts/llm-complete.ts` | `openai-llm` |
| `sessions:store` | Persistent conversation session storage | `contracts/sessions-store.ts` | `llm-session-manager` |
| `tools:registry` | In-memory tool registration, listing, and invocation chokepoint | `contracts/tools-registry.ts` | `llm-tools-registry` |
| `prompt:registry` | Dynamic system prompt assembly from registered sections | `contracts/prompt-registry.ts` | `llm-system-prompt` |
| `slash:registry` | Slash-command registration and dispatch | `contracts/slash-registry.ts` | `llm-slash-commands` |
| `skills:registry` | File-backed skill manifest registry | `contracts/skills-registry.ts` | `llm-skills` |
| `memory:store` | User-level persistent memory read/write | `contracts/memory-store.ts` | `llm-memory` |
| `agents:registry` | File-backed subagent manifest registry and dispatch tool | `contracts/agents-registry.ts` | `llm-agents` |
| `mcp:bridge` | MCP server lifecycle, tool bridging, and status | `contracts/mcp-bridge.ts` | `llm-mcp-bridge` |
| `driver:run-conversation` | High-level turn-loop driver | `contracts/driver.ts` | `llm-driver` |
| `dispatch:strategy` | Tool-call dispatch strategy (prepare request + handle response) | `contracts/dispatch.ts` | `llm-native-dispatch` |
| `ui:channel` | TUI I/O surface (read input, write output, busy state) | `contracts/ui-channel.ts` | `llm-tui` |
| `ui:completion-source` | Completion popup source registry | `contracts/ui-completion.ts` | `llm-tui` |
| `ui:status` | Status-bar marker service | `contracts/ui-status.ts` | `llm-tui` |
| `ui:theme` | TUI theme token access | `contracts/ui-theme.ts` | `llm-tui` |
| `ui:tool-renderer` | Per-tool inline TUI renderer registry | `contracts/ui-tool-renderer.ts` | `llm-tui` |

## Naming convention

**`<domain>:<role>`** — both halves lowercase, kebab-case allowed, exactly one
colon, no plugin-name prefixes ever.

Domains in use: `events`, `llm`, `sessions`, `tools`, `prompt`, `slash`,
`skills`, `memory`, `agents`, `mcp`, `driver`, `dispatch`, `ui`.

Roles in use: `vocabulary`, `complete`, `store`, `registry`, `strategy`,
`bridge`, `channel`, `completion-source`, `status`, `theme`, `tool-renderer`,
`run-conversation`.

`*:registry` — an in-process capability hub (plugins register, others query).
`*:store` — a persistence layer for user/conversation data. Distinct concepts;
do not conflate.

New contracts may add domains or roles but must follow the shape and the
no-plugin-prefix rule.

## Cardinality

Every contract is **cardinality-one**: exactly one plugin provides it per
harness boot. Attempting to provide the same contract twice is a boot error.

`dispatch:strategy` deserves special mention: both `llm-native-dispatch` and
`llm-codemode` are related to tool dispatch, but they are **not** alternatives
for this slot. `llm-codemode` registers a tool (`execute_typescript`) into
`tools:registry` and is orthogonal to the dispatch strategy. Only
`llm-native-dispatch` provides `dispatch:strategy`. The two plugins must both
appear in the harness manifest to get sandboxed TypeScript tool execution.

## Hard vs. optional consumption

Plugins use `ctx.consumeService(id)` (hard) when they cannot meaningfully run
without the contract, and guarded `ctx.useService<T>(id)` (optional) when they
degrade gracefully when the provider is absent. Hard dependencies appear in
`services.consumes` on the `KaizenPlugin` descriptor; optional ones do not.

The full per-plugin audit table is in
`docs/superpowers/specs/2026-05-13-llm-contracts-foundation-refactor-design.md`
§8. Cross-reference `AGENTS.md` for the authoring rules.

## How to add a new contract

1. Create `plugins/llm-contracts/contracts/<topic>.ts` with the TypeScript
   interface(s), an exported `CONTRACT_ID` string constant, and an exported
   `DESCRIPTION` string constant.
2. Add `export type { ... } from "./contracts/<topic>";` to `public.ts`. If the
   contract exports a runtime value (like `CANCEL_TOOL`), use `export { ... }`
   instead of `export type { ... }`.
3. In `index.ts`, import the module and add
   `ctx.defineService(<topic>.CONTRACT_ID, { description: <topic>.DESCRIPTION });`
   inside `setup(ctx)`.
4. In the implementation plugin: remove any existing `ctx.defineService` call
   for this contract; update `ctx.provideService` to use the new `CONTRACT_ID`;
   replace local type definitions with `import type { ... } from "llm-contracts/public"`.
5. In consumer plugins: update `useService` / `consumeService` call IDs;
   replace type imports with `import type { ... } from "llm-contracts/public"`.
6. Add `"llm-contracts": "workspace:*"` to `dependencies` in any affected
   plugin's `package.json` that did not already have it.
7. Run `bun test` for affected plugins and verify the harness boots.

## Substitutability acid test

The goal is to verify that swapping any implementation plugin does not require
changes to any other plugin.

Minimal check per contract:

1. Create a throwaway stub plugin at `plugins/_acidtest/<contract-slug>/index.ts`
   that imports the contract type from `llm-contracts/public` and calls
   `ctx.provideService("<contract-id>", <minimal-stub>)`.
2. In `harnesses/openai-compatible.json`, temporarily replace the implementation
   plugin entry with `official/_acidtest-<slug>@0.1.0`.
3. Boot the harness. No other plugin should error during setup (the feature will
   not work; that is expected).
4. Restore the manifest. Delete the throwaway plugin. Do not commit acid-test
   scaffolding.

Full substitutability verification for every contract is Phase 4 of the
refactor — see the design spec for the complete recipe.
