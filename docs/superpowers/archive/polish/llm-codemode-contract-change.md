# llm-codemode Contract Change

Date: 2026-05-12
Session target: llm-tools-registry (downstream change)

## Summary

`llm-codemode` no longer redeclares `ToolSource`. The plugin now imports
`ToolSource` from `llm-tools-registry/public` and owns its own closed
presentation bucket type (`CodemodeBucket`) plus a `bucketFor()` mapping
function. All three exhaustive switches on tool provenance (assembler,
sandbox-host, sandbox-entry) route through this single function. Unknown
provenance kinds fall through to the `tools` bucket so the rendered
`.d.ts` surface seen by the LLM stays byte-stable for every well-known
kind. Published as `llm-codemode@0.2.0`.

## Previous Contract

- Owner: `llm-codemode` for the bucket policy; `llm-tools-registry` for
  `ToolSource`.
- Consumers: any sandbox user. The bucket policy is consumed indirectly
  through the rendered `kaizen.*` surface that the LLM sees and through the
  live `kaizen.*` namespace exposed in the worker.
- Service/event/tool/type/config surface:
  - `RegistrationMeta.source` in `rpc-types.ts` was a literal copy of the
    closed `ToolSource` union.
  - Three exhaustive `switch (s.kind)` blocks (assembler `groupBySource`,
    sandbox-host `buildKaizenGlobal`, sandbox-entry `makeKaizen`) hard-coded
    the same closed bucket map.
- Old behavior or shape: any new provenance kind required edits in
  *both* `llm-tools-registry/public.d.ts` and `llm-codemode/rpc-types.ts`,
  plus the three switches in codemode.

## New Contract

- New behavior or shape:
  - `rpc-types.ts` imports `ToolSource` from `llm-tools-registry/public`;
    `RegistrationMeta.source` is now typed as the open `ToolSource`.
  - `buckets.ts` is the single source of truth for the presentation
    policy. It exports:
    ```ts
    type CodemodeBucket =
      | { kind: "tools" }
      | { kind: "mcp"; server: string }
      | { kind: "agents" }
      | { kind: "skills" }
      | { kind: "memory" };

    function bucketFor(source: ToolSource): CodemodeBucket;
    function normalizeServerName(name: string): string;
    ```
  - Mapping: `local → tools`, `mcp → mcp` (server name normalized for
    TS-identifier safety), `agent → agents`, `skill → skills`,
    `memory → memory`. Unknown kinds default to `tools`. Unknown or
    non-string `mcp.server` defaults to `"unknown"`.
  - `assembler.ts`, `sandbox-host.ts`, and `sandbox-entry.ts` all switch
    exhaustively over `CodemodeBucket` instead of `ToolSource.kind`.
    Adding a new bucket variant breaks all three switches at compile time
    in a single coordinated edit.
  - `assembler.ts` re-exports `normalizeServerName` so the existing
    `sandbox-host.ts` import path and the `assembler.test.ts` tests
    continue to resolve without churn.
- Compatibility notes:
  - The rendered `.d.ts` surface and the live `kaizen.*` namespace are
    byte-identical for any registration set composed of well-known
    provenance kinds. `surfaceHash()` outputs are unchanged for the same
    inputs.
  - Unknown provenance kinds previously could not exist (closed union).
    They now silently land under `kaizen.tools.<name>`. This is the
    intentional fallback: it avoids inventing a new visible namespace for
    surprise kinds.
  - `RegistrationMeta.source` over the worker postMessage boundary still
    serializes the same JSON payload; only the static type widened.
- Migration required by consumers: none. Codemode has no external
  consumers of `RegistrationMeta` or `buckets.ts`.

## Affected OpenAI-Compatible Plugins

- `llm-tools-registry@0.3.0`: opened the `ToolSource` shape (driving
  change). See `docs/polish/llm-tools-registry-contract-change.md`.
- `llm-codemode@0.2.0`: this plugin. Internal refactor; no external
  contract change.
- Verified compatible: every other openai-compatible plugin. No plugin
  imports `RegistrationMeta`, the duplicated union, or the codemode
  bucket switches.

## Verification

- Tests run:
  - `bun test plugins/llm-codemode` — 76/76 pass, including the new
    `test/buckets.test.ts` covering known kinds, mcp server
    normalization, unknown-kind fallback, and missing/non-string
    `mcp.server` fallback.
  - `bun test plugins/llm-tools-registry` — 33/33 pass.
  - `bun test` (full repo) — 1173/1173 pass.
  - `bunx kaizen plugin validate plugins/llm-codemode` — pass.
- Tests not run and why: live MCP / model server integration tests gated
  by external services. The bucket policy is exercised by the in-process
  e2e sandbox test (`test/e2e-sandbox.test.ts`).

## Follow-Up

- If a registrar introduces structured metadata for a new provenance
  kind that genuinely deserves its own `kaizen.<bucket>` namespace, add a
  new variant to `CodemodeBucket` and update the three exhaustive
  switches. The compiler will surface every site that needs editing.
- Consider whether the `tools` fallback for unknown kinds is the right
  long-term default versus a dedicated `other` bucket. The current
  choice favors LLM-surface stability over honesty; the trade-off is
  worth revisiting if surprise kinds become common.

---

# llm-codemode Contract Change — 0.3.0

Date: 2026-05-13
Session target: llm-codemode

## Summary

`llm-codemode` 0.3.0 tightens its surface in three small ways that do not
affect the runtime tool shape or the in-sandbox `kaizen.*` global:

1. Removes the dead `maxBlocksPerResponse` config key from `CodeModeConfig`
   and the `formatToolResult` cap shape. The key was documented as
   "reserved" and was never consulted at runtime.
2. Drops `llm-tui:tool-renderer` from `services.consumes`. The TUI
   integration is optional and is accessed through a guarded `useService`
   lookup; the prior declaration overstated the dependency.
3. Deletes `public.d.ts`. The file was not exposed in `package.json`
   `exports`, had no internal or external consumers, and its
   `CodeModeConfig` interface had drifted from the real one in
   `config.ts` (missing the `sandbox` field). The plugin has no
   intentional cross-plugin public API — it is a pure tool registrant.

A shared `kaizen-tree.ts` helper now backs both the host and the sandbox
worker's view of the `kaizen.{tools,mcp,agents,skills,memory}` grouping.
This is an internal refactor; the runtime shape consumers see is unchanged.

## Previous Contract

- Owner: `llm-codemode`.
- Consumers (config): users who edit
  `~/.kaizen/plugins/llm-codemode/config.json`.
- Consumers (services): the openai-compatible harness.
- Consumers (public types): none. `package.json` exports did not expose
  `./public`, and no plugin imports from `llm-codemode/public`.
- Old behavior or shape:
  - `CodeModeConfig` included `maxBlocksPerResponse: number`; `validate()`
    rejected `<= 0`; `formatToolResult` accepted it in `caps` but never
    referenced it.
  - `services.consumes` listed `["tools:registry", "llm-tui:tool-renderer"]`,
    and `setup()` called `ctx.consumeService("llm-tui:tool-renderer")` even
    though the renderer was already guarded by a `useService` lookup.
  - `public.d.ts` exported a 4-field `CodeModeConfig` without `sandbox`.

## New Contract

- New behavior or shape:
  - `CodeModeConfig`: `{ timeoutMs, maxStdoutBytes, maxReturnBytes, sandbox: "bun-worker" }`.
  - `services.consumes`: `["tools:registry"]`.
  - `public.d.ts`: deleted.
  - `kaizen-tree.ts`: new internal module shared by host and worker.

- Compatibility notes:
  - Existing user `config.json` files that set `maxBlocksPerResponse`
    continue to load. The config loader uses
    `{ ...DEFAULT_CONFIG, ...parsed }`, which lets unknown keys pass
    through; `validate()` no longer reads the field, so it cannot fail on
    it. The key now has no effect (which is what it had at runtime all
    along — only the validator made it look load-bearing).
  - Harnesses pinned at `official/llm-codemode@0.2.0` keep working
    unchanged. Newly pinned harnesses should target `0.3.0`. The
    openai-compatible harness in this repo was bumped to `0.3.0`.

- Migration required by consumers: none. The runtime tool surface
  (`execute_typescript`), the `tool:progress` event, and the `kaizen.*`
  global inside the sandbox are byte-identical.

## Affected OpenAI-Compatible Plugins

- `llm-codemode`: bumped from `0.2.0` to `0.3.0`; harness coordinate
  updated; marketplace entry adds `0.3.0`.
- `llm-tools-registry`, `llm-tui`, `llm-driver`, `openai-llm`,
  `llm-events`, `llm-status-items`, `llm-native-dispatch`,
  `llm-mcp-bridge`, `llm-skills`, `llm-memory`, `llm-agents`,
  `llm-slash-commands`, `llm-system-prompt`, `llm-tavily-search`,
  `llm-local-tools`, `llm-session-manager`, `llm-hooks-shell`: verified
  compatible. None import from `llm-codemode/public` or its services.

## Verification

- Tests run: `bun test plugins/llm-codemode` (all pass, including the new
  `test/kaizen-tree.test.ts` that locks the shared grouping shape).
- Tests not run and why: full-repo `bun test` not run; this session only
  touched `llm-codemode` and its harness coordinate. No service contract
  owned by another plugin changed.
