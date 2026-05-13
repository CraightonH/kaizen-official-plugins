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
