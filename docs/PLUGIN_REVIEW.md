# Polish Sprint Instructions

Use this document to seed focused polish sessions for the official Kaizen plugin
marketplace. The intended cadence is one session, one plugin, one bounded set of
quality improvements.

## Scope

Polish only plugins included by `harnesses/openai-compatible.json`:

- `llm-events`
- `llm-session-manager`
- `openai-llm`
- `llm-tools-registry`
- `llm-local-tools`
- `llm-tavily-search`
- `llm-mcp-bridge`
- `llm-skills`
- `llm-memory`
- `llm-agents`
- `llm-slash-commands`
- `llm-system-prompt`
- `llm-native-dispatch`
- `llm-codemode`
- `llm-driver`
- `llm-status-items`
- `llm-hooks-shell`
- `llm-tui`

Do not investigate or edit Claude-specific plugins during these polish sessions
unless the user explicitly expands the scope. Keep Kaizen core source searches
limited; prefer local platform docs under `~/git/kaizen/docs`, especially
`~/git/kaizen/docs/reference/plugin-standards.md`, before reading core source.

## Session Rules

1. Start by naming the target plugin and confirming it is listed in
   `harnesses/openai-compatible.json`.
2. Read only the files needed for that plugin first: `package.json`,
   `README.md`, `CLAUDE.md` if present, `public.d.ts` if present, `index.ts`,
   directly related source files, and the plugin's tests.
3. Check `git status --short` before editing. Do not revert unrelated user
   changes.
4. Prefer small, local improvements over broad refactors. Preserve public
   behavior unless the session explicitly handles a contract change.
5. Keep naming, exported types, service names, event names, tool names, config
   keys, and README wording consistent with the existing openai-compatible
   plugin set.
6. When an external dependency appears, identify the contract owner before
   changing behavior. External dependencies include package imports from another
   plugin, `ctx.useService`, `ctx.consumeService`, emitted or handled events,
   registered tools, slash commands, status items, shared config files, and
   types imported from another plugin's `public.d.ts`.
7. Surface larger implementation issues even when they are not fixed in the
   current session. If the issue spans multiple plugins, changes architecture,
   or needs sequencing, document it as a refactor opportunity instead of hiding
   it inside a narrow cleanup.
8. Run targeted tests for the changed plugin. If a public contract or shared
   behavior changed, also run the affected consumer tests.

## Contract Ownership

Use this ownership model when a plugin depends on another plugin:

- Service names are owned by the plugin that defines or provides the service in
  `services.provides`, `ctx.defineService`, or `ctx.provideService`. For
  example, `tools:registry` is owned by `llm-tools-registry` even if shared
  interface types are re-exported elsewhere.
- Event vocabulary and shared LLM primitive types are owned by `llm-events`.
- Tool schemas and tool result shapes are owned by the plugin that registers
  the tool, unless a broker plugin's `public.d.ts` defines the shared shape.
- Slash command contracts are owned by the plugin that registers or dispatches
  the command, depending on which behavior is changing.
- Config file schemas are owned by the plugin that reads the config.
- UI status item payloads are owned by the plugin that emits the item, while
  rendering assumptions are owned by `llm-tui`.

Before editing a dependent contract:

1. Inspect the owner plugin's `README.md`, `public.d.ts`, `index.ts`, and
   relevant tests.
2. Check whether `docs/polish/<owner-plugin>-contract-change.md` already
   exists. If it exists, read it before deciding how to proceed.
3. If the target plugin needs a breaking contract change, document it in
   `docs/polish/<target-plugin>-contract-change.md` before or alongside the
   code change.
4. If the changed contract affects consumers in the openai-compatible harness,
   update those consumers in the same session when practical. If not practical,
   list the required follow-up precisely in the contract-change doc.

## Contract-Change Docs

Create `docs/polish/<plugin>-contract-change.md` when a polish session changes a
cross-plugin contract in a way that can break another plugin. Use this template:

```md
# <plugin> Contract Change

Date: YYYY-MM-DD
Session target: <plugin>

## Summary

Short description of the contract that changed and why.

## Previous Contract

- Owner:
- Consumers:
- Service/event/tool/type/config surface:
- Old behavior or shape:

## New Contract

- New behavior or shape:
- Compatibility notes:
- Migration required by consumers:

## Affected OpenAI-Compatible Plugins

- <plugin>: <required update or "verified compatible">

## Verification

- Tests run:
- Tests not run and why:
```

Non-breaking clarifications, internal refactors, test additions, README fixes,
and local bug fixes do not need a contract-change doc.

## Refactor Opportunity Docs

Create `docs/polish/<plugin>-refactor-opportunities.md` when a session finds a
larger implementation problem that should not be fixed opportunistically inside
the current plugin polish. This is separate from contract-change documentation:
contract-change docs explain what broke or migrated; refactor-opportunity docs
explain why the current implementation is naive, fragile, duplicated, or
awkward at a design level.

Document larger-scope refactors when you see issues like:

- The same parsing, validation, retry, stream assembly, mock context, config
  loading, filesystem handling, or result-shaping logic duplicated across
  plugins.
- Stringly typed service, event, tool, status, or slash-command protocols that
  should be centralized or typed.
- A plugin doing too many roles in `setup()` or mixing registration,
  orchestration, rendering, persistence, and IO in one module.
- Hand-rolled code for a domain where this repo already has a local helper,
  shared type, registry, parser, or test fixture pattern.
- Brittle state management, global mutable state, poor cleanup, or concurrency
  assumptions that make tests pass only in a narrow order.
- Error handling that loses structured context, makes recovery impossible, or
  forces consumers to pattern-match human text.
- Persistence or config formats that need migration/versioning before the next
  round of features.
- Tests that assert incidental implementation details instead of public
  behavior, making useful refactors unnecessarily risky.

Use this template:

```md
# <plugin> Refactor Opportunities

Date: YYYY-MM-DD
Session target: <plugin>

## Opportunity

Short description of the naive or fragile implementation pattern.

## Evidence

- Files/functions involved:
- Concrete symptoms:
- Existing tests that make the issue visible, if any:

## Scope

- Local to this plugin or cross-plugin:
- Affected openai-compatible plugins:
- Related contracts:

## Suggested Direction

- Proposed shape of the refactor:
- Migration or sequencing notes:
- Risks:

## Not Done In This Session

Why this should not be folded into the current polish change.
```

If an opportunity is small and local, fix it directly with tests instead of
creating a doc. If it is broad, document it and keep the current session
bounded.

## Polish Checklist

Use this checklist for the selected plugin. Apply judgment; do not force churn
where the existing code is already clear.

- Manifest and metadata: `package.json` name/version/exports/keywords match
  Kaizen plugin standards, the marketplace entry, and the harness coordinate.
- Public surface: `public.d.ts` exports only intentional cross-plugin API, names
  the owning plugin for shared contracts, and does not leak internal helpers.
- Service contracts: `services.provides`, `services.consumes`,
  `ctx.defineService`, `ctx.provideService`, `ctx.consumeService`, and
  `ctx.useService` agree on names and behavior.
- Event contracts: event names use shared vocabulary when available; payload
  shape is documented or typed; handlers tolerate missing optional fields.
- Tool contracts: schemas are valid, argument validation is strict, failures are
  returned in the broker's expected shape, and LLM-facing names/descriptions are
  stable.
- Config and secrets: JSON schemas validate, defaults exist for optional
  non-secret keys, secrets use `ctx.secrets`, README documents all keys, and
  missing optional config degrades clearly.
- Permissions: tier and scoped permissions match actual behavior; unscoped or
  network/filesystem access is justified in README.
- Naming consistency: file names, exported symbols, service names, event names,
  tool names, config keys, test names, and README terms use the same vocabulary.
- Edge cases: empty input, malformed input, missing files, absent secrets,
  missing optional services, cancellation, retries, duplicate registration,
  partial streams, and concurrent calls are handled intentionally where relevant.
- Error handling: expected user/runtime failures return structured errors or
  clear messages; thrown errors are reserved for bugs or unrecoverable setup
  failures.
- State and persistence: file paths are normalized, writes are atomic enough for
  the plugin's risk level, corrupted persisted state has a recovery path, and
  tests cover migration or backward compatibility if state shape changes.
- Async behavior: setup is idempotent enough for tests, subscriptions do not
  leak, long-running work observes cancellation when a cancellation contract is
  present, and cleanup hooks exist where needed.
- Implementation shape: modules have clear responsibilities, shared algorithms
  are not copied across files or plugins, data transformations are typed, and
  orchestration code is not tangled with parsing, persistence, rendering, or IO.
- Tests: existing tests cover the public contract and the bugs being fixed;
  add narrow regression tests for every behavioral change.
- Docs: README reflects current install/config/permissions/service or tool
  surface; examples compile mentally against current exported names.
- Marketplace and harness drift: package versions, `.kaizen/marketplace.json`
  versions, and `harnesses/openai-compatible.json` coordinates are consistent
  or any intentional drift is documented.

## Validation

Prefer targeted validation first:

```sh
bun test plugins/<plugin>
bunx tsc -p plugins/<plugin>/tsconfig.json --noEmit
kaizen plugin validate plugins/<plugin>
```

When a contract changes or shared foundation code is touched, also run tests for
affected consumers from `harnesses/openai-compatible.json`. If the session
touches `llm-events`, `llm-tools-registry`, `llm-driver`, or `llm-tui`, consider
running the full `bun test` before finishing.

Do not run live integration tests that require external services, API keys,
local model servers, or MCP servers unless the user explicitly asks for them or
the environment is already configured.

## Finishing a Session

End each polish session with:

- The target plugin.
- The files changed.
- Any contract-change doc created or read.
- Any refactor-opportunity doc created or updated.
- Tests and validation commands run.
- Remaining risks or follow-up items, especially affected plugins that were not
  updated.
