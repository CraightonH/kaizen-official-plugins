# llm-tools-registry Contract Change

Date: 2026-05-12
Session target: llm-tools-registry

## Summary

`ToolSource` is now an open shape (`{ kind: string; [k: string]: unknown }`)
instead of a closed discriminated union. New provenance kinds can be
introduced by any registrar without editing `llm-tools-registry/public.d.ts`.
The set of well-known kinds (`local`, `mcp` with `server: string`, `agent`,
`skill`, `memory`) is documented in the README; consumers that group tools
for presentation (notably `llm-codemode`) own their own closed bucket type
and a documented fallback for unknown kinds. Published as
`llm-tools-registry@0.3.0`.

## Previous Contract

- Owner: `llm-tools-registry`.
- Consumers: any plugin that constructs a `ToolSource` literal or pattern-
  matches on `source.kind`. In the openai-compatible harness:
  - Registrars: `llm-mcp-bridge`, `llm-agents`, `llm-skills`, `llm-memory`,
    `llm-tools-registry` itself (defaults to `local`).
  - Read-side bucket policy: `llm-codemode` (`assembler.ts`, `sandbox-host.ts`,
    `sandbox-entry.ts`).
  - Read-side presentation: `llm-tools-registry/slash.ts:sourceKey` (already
    kind-agnostic via a default branch).
- Service/event/tool/type/config surface: the TypeScript shape of
  `ToolSource` exported from `llm-tools-registry/public`, and the shape of
  `ToolRegistration.source`. Runtime service surface unchanged.
- Old behavior or shape: closed union literal —
  `{ kind: "local" } | { kind: "mcp"; server: string } | { kind: "agent" } |
   { kind: "skill" } | { kind: "memory" }`. Adding a new kind required a
  breaking edit to `llm-tools-registry/public.d.ts` (and silently to
  `llm-codemode/rpc-types.ts`, which redeclared the union).

## New Contract

- New behavior or shape:
  ```ts
  export interface ToolSource {
    kind: string;
    [k: string]: unknown;
  }
  ```
  Well-known kinds and their structured metadata are documented in
  `plugins/llm-tools-registry/README.md`. The `mcp` kind continues to carry
  `server: string`; every other well-known kind is a bare tag.
- Compatibility notes:
  - Runtime: no change. The registry stores `source` opaquely; emitted events
    (`tools:registered`, `tools:unregistered`, `tool:*` correlation events)
    are unchanged.
  - Type-only: exhaustive `switch (source.kind)` checks against the old union
    now type as non-exhaustive when narrowed to `string`. Consumers that need
    exhaustiveness must define their own closed bucket type plus an explicit
    fallback for unknown kinds (see the `llm-codemode` contract-change doc
    for the recommended pattern).
- Migration required by consumers:
  - Construction sites: no change. `{ kind: "local" }`, `{ kind: "mcp",
    server: ... }`, etc. continue to satisfy the new type.
  - Read sites that switch exhaustively on `source.kind`: either accept the
    loosened typing or wrap the source in a consumer-owned closed bucket
    type with a documented fallback. `llm-codemode` did the latter.

## Affected OpenAI-Compatible Plugins

- `llm-tools-registry@0.3.0`: owner. Opened the type, documented the
  well-known kinds in `README.md`, and added a registry test that exercises
  a custom `kind: "workflow"` registration through `list({ sources })`.
- `llm-codemode@0.2.0`: bumped in the same session. Imports `ToolSource`
  from `llm-tools-registry/public` and introduces `buckets.ts` with a
  closed `CodemodeBucket` type and `bucketFor()` function so the assembler
  and sandbox-host/sandbox-entry switches stay exhaustive. Unknown kinds
  fall through to the `tools` bucket (byte-stable for known kinds).
- `llm-mcp-bridge`, `llm-agents`, `llm-skills`, `llm-memory`: verified
  compatible — they only construct `ToolSource` literals, never narrow on
  `kind`. No code change required.
- Other openai-compatible plugins: verified by grep to not subscribe to
  `tools:registered` / `tools:unregistered` or to pattern-match on
  `source.kind`.

## Verification

- Tests run:
  - `bun test plugins/llm-tools-registry` — 33/33 pass (added one regression
    test for the open shape).
  - `bun test plugins/llm-codemode` — 76/76 pass (added a `buckets.test.ts`).
  - `bun test` (full repo) — 1173/1173 pass, 2 skip (existing skips for
    external-service integration paths).
  - `bunx kaizen plugin validate plugins/llm-tools-registry` — pass.
  - `bunx kaizen plugin validate plugins/llm-codemode` — pass.
  - `bunx kaizen marketplace validate .` — pass.
- Tests not run and why: live integration tests gated by local services or
  environment (LM Studio, MCP servers) were not enabled. The bucket policy
  change is exercised by the host-side and worker-side unit tests in
  `llm-codemode/test/`, including the e2e sandbox test.

## Follow-Up

- `llm-mcp-bridge` registers its own control tools (`mcp:read`, `mcp:list`)
  as `kind: "local"` rather than introducing a dedicated provenance kind.
  This works today and stays correct after the refactor (the `local` bucket
  is the right presentation bucket for these tools). If the bridge later
  wants distinct provenance metadata for its control tools, it can now
  introduce a new `kind` without coordinating a registry version bump.
- `sourceKey()` in `llm-tools-registry/slash.ts` remains plugin-internal.
  No external consumer needs it today. Promote it to the public surface
  only if a future consumer wants the canonical `mcp:<server>` label
  rendering.
