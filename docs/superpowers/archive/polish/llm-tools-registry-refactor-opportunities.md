# llm-tools-registry Refactor Opportunities

Date: 2026-05-12
Session target: llm-tools-registry
Status: Implemented on 2026-05-12 via the two-step migration described below.
See `llm-tools-registry-contract-change.md` (0.3.0) and
`llm-codemode-contract-change.md` (0.2.0).

## Opportunity

`ToolSource` is a closed discriminated union exported from
`llm-tools-registry/public.d.ts`. Adding a new provenance kind looks like a
single-plugin contract change, but in practice it requires editing at least
two plugins' public surfaces — the registry *and* `llm-codemode`, which
re-declares the same union in `rpc-types.ts` and pattern-matches it
exhaustively in its assembler. The current shape also conflates two
distinct concerns into one field: **where a tool came from** (provenance)
and **which bucket a renderer should put it in** (presentation policy).
`llm-mcp-bridge` already exploits the conflation by registering its own
control tools (`mcp:read`, `mcp:list`) as `kind: "local"`.

## Evidence

### Owner surface

- `plugins/llm-tools-registry/public.d.ts:22-33` — `ToolSource` union and
  `ToolRegistration`.
- `plugins/llm-tools-registry/registry.ts` — `Entry`, `register*`, and the
  `list({ sources })` filter all treat `source` opaquely. No registry-internal
  code branches on a specific `kind`.

### Construction sites (write)

- `plugins/llm-agents/index.ts:64` — `{ kind: "agent" }`.
- `plugins/llm-memory/tools.ts:113,117` — `{ kind: "memory" }` (recall + save).
- `plugins/llm-skills/index.ts:118` — `{ kind: "skill" }`.
- `plugins/llm-mcp-bridge/lifecycle.ts:243` — `{ kind: "mcp", server: <name> }`
  for tools brokered from a real MCP server.
- `plugins/llm-mcp-bridge/service.ts:56-57` — `{ kind: "local" }` for the
  bridge's own `mcp:read` / `mcp:list` control tools. The bridge plugin is
  the registrar but the tools are not "from" any MCP server, so they get
  tagged `local`. This is the conflation in action.
- `plugins/llm-tools-registry/registry.ts:58` — `register(schema, handler)`
  defaults to `{ kind: "local" }`.

### Read sites (consume)

- `plugins/llm-tools-registry/slash.ts:21-26` (`sourceKey`) — special-cases
  `mcp`, every other kind falls through `default: return source.kind`.
  Cosmetic; copes with arbitrary kinds today.
- `plugins/llm-codemode/assembler.ts:40-63` — **the load-bearing consumer.**
  Exhaustive `switch` over all 5 kinds to build the codemode global surface
  buckets: `local`, `mcp[normalizedServer]`, `agents`, `skills`, `memory`.
  Each bucket determines how a tool is exposed in the rendered `.d.ts` that
  the LLM sees.
- `plugins/llm-codemode/rpc-types.ts:7-11` — **the leak.** The full
  `ToolSource` union is re-declared verbatim, not imported. Adding a kind
  today silently requires editing this file too.

### Concrete symptoms

- The "single plugin contract" framing is wrong: any kind addition touches
  `llm-tools-registry/public.d.ts` *and* `llm-codemode/rpc-types.ts` *and*
  the codemode assembler's bucket switch.
- The closed union does not buy the registry anything — it has no
  kind-specific behavior. It does buy the codemode assembler an
  exhaustiveness check, which is real value the slash renderer does not use.
- The `mcp` kind is the only one that carries structured metadata
  (`server: string`). The other four are bare tags. So the *shape problem*
  is general, but the *real data inside the union* is MCP-specific.
- Provenance ≠ presentation: `llm-mcp-bridge`'s control tools demonstrate
  that registrars already need a separate axis to say "this tool belongs in
  the `local` render bucket regardless of who registered it."

### Existing tests that make the issue visible

- `plugins/llm-tools-registry/test/registry.test.ts` `public types —
  ToolSource` admits every spec'd kind by construction.
- `plugins/llm-tools-registry/test/slash.test.ts` only exercises `local`
  and `mcp:<server>`, confirming the rest of the union is currently
  surface-only at the registry level.
- `plugins/llm-codemode` tests (assembler / dts-render) are the ones that
  would actually break under a careless `ToolSource` change.

## Scope

- Local to this plugin or cross-plugin: cross-plugin. The load-bearing
  consumer is `llm-codemode`, not the registry.
- Affected openai-compatible plugins:
  - `llm-tools-registry` — owns the provenance shape.
  - `llm-codemode` — owns the presentation bucket policy and currently
    re-declares the contract.
  - `llm-mcp-bridge`, `llm-agents`, `llm-skills`, `llm-memory` — registrars
    that construct `ToolSource` literals.
  - `llm-tools-registry` slash renderer — passive consumer; already
    kind-agnostic.
- Related contracts:
  - `ToolSource`, `ToolRegistration`, `list({ sources })` filter shape.
  - `llm-codemode` RPC types and rendered `.d.ts` bucket layout.
  - Slash `/tools:list` grouping label format.

## Suggested Direction

This is a two-step migration. Doing only step 1 trades one closed contract
for two leakier ones; doing only step 2 still forces a registry public-
surface edit for every new kind.

### Step 1 — Open the provenance shape in `llm-tools-registry`

Replace the closed union with an open shape:

```ts
export interface ToolSource {
  kind: string;
  [k: string]: unknown; // structured metadata is per-kind; e.g. mcp adds `server: string`
}
```

Document the well-known kinds (`local`, `mcp`, `agent`, `skill`, `memory`)
and the `mcp.server: string` convention in the README. The registry stops
gatekeeping the set; new provenance kinds become a documentation change.

Move `sourceKey(source: ToolSource): string` out of `slash.ts` and into the
public surface so consumers do not redefine the `mcp:<server>` convention.

Bump `llm-tools-registry` minor and file a contract-change doc.

### Step 2 — Make `llm-codemode` own its bucket policy

Today `llm-codemode` re-declares `ToolSource` in `rpc-types.ts` and
exhaustively switches on it in `assembler.ts`. After step 1 the union is
no longer closed, so codemode has to decide what to do with unknown kinds.
The right shape:

- `llm-codemode` imports `ToolSource` from `llm-tools-registry/public`;
  the duplicated declaration in `rpc-types.ts` is deleted.
- `llm-codemode` declares its own closed `CodemodeBucket` type internally
  (the buckets are a codemode presentation concern, not a registry concern):
  `"local" | "mcp" | "agents" | "skills" | "memory" | "other"`.
- A single `bucketFor(source: ToolSource): CodemodeBucket` function maps
  arbitrary `kind` values into a bucket, defaulting unknown kinds to
  `other` (or to `local` if the existing rendered `.d.ts` shape needs to
  stay byte-identical for unknown kinds — to be decided when codemode is
  edited).
- The assembler switches exhaustively on `CodemodeBucket`, not on `kind`.
  Exhaustiveness check stays, the new-kind-breaks-codemode footgun goes away.

Bump `llm-codemode` minor; document the bucket policy in its README. No
registry change required for this step.

## Alternatives considered

### Alternative A — keep the closed union, deduplicate

Leave `ToolSource` closed; have `llm-codemode/rpc-types.ts` import the type
instead of re-declaring it. Cheapest possible change. Resolves the leak but
not the underlying ergonomic cost: every new kind still forces edits in the
registry's public surface, and `llm-mcp-bridge`'s "control tools tagged
local" awkwardness stays unaddressed.

Reasonable if we believe no new kinds will be introduced. Not recommended,
because adding `slash`, `remote`, `workflow`, or plugin-private kinds is
plausible and currently each one is gratuitously breaking.

### Alternative B — kill `ToolSource` entirely, classify via `schema.tags`

`ToolSchema` already has a `tags?: string[]` field. Move provenance into
well-known tag prefixes:

- `source:local`
- `source:mcp:<server>`
- `source:agent`
- `source:skill`
- `source:memory`

Drop `ToolSource` and `ToolRegistration.source`. Filter via the existing
`list({ tags })` API. Consumers parse the prefix to extract `server` when
needed.

Pros:
- Deletes a contract instead of growing one.
- Aligns provenance with the existing freeform classification mechanism.
- Naturally extensible — any consumer can introduce new prefixes without
  touching the registry.

Cons:
- Loses typed `server: string` extraction; consumers do their own string
  parsing (`tag.startsWith("source:mcp:")`).
- The `tags` field becomes overloaded with a provenance convention; tests
  and rendered outputs change shape.
- Existing event payloads (`tools:registered { source }` and
  `tools:unregistered { source }`) become tag-derived; downstream
  subscribers across the harness need to migrate.

Reasonable if we decide provenance is presentation metadata, not a typed
domain concept. Heavier consumer migration than the two-step path above.

### Alternative C — relocate provenance to a shared foundation package

Treat tool provenance as a foundation concept owned by `llm-events` (or a
new neutral package), the way `ToolSchema` is foundation. Lets owners of
each provenance kind contribute structured metadata without bouncing
through the registry's public surface.

Explicitly rejected for now: the recent `llm-events` public-surface
refactor (`docs/polish/llm-events-public-surface-refactor-plan.md`) moved
*away* from `llm-events` as an aggregator of higher-level concepts. Only
worth revisiting if multiple plugins need to attach structured provenance
metadata that the registry cannot remain opaque about.

## Risks

- **Step 1 silently weakens type safety at every read site** that relies on
  exhaustiveness against the union. Slash is fine; `llm-codemode/assembler.ts`
  is not. Step 2 must land alongside step 1 (or before it is published) to
  keep the codemode safety net.
- **`rpc-types.ts` duplication is an existing bug.** Any plan that ignores
  it leaves the migration half-done. Inventory: does any other plugin
  re-declare the union? Spot-check before publishing.
- **Bucket fallback policy is not byte-neutral.** If codemode decides to
  route unknown kinds to `other` instead of `local`, the rendered `.d.ts`
  shape that the LLM sees changes. Decide deliberately; benchmark against
  existing surface hashes (`surfaceHash` in `assembler.ts`) before changing.
- **`llm-mcp-bridge` control-tool tagging is wrong on its own merits.**
  Registering `mcp:read` / `mcp:list` as `kind: "local"` was a workaround
  for the conflation. After the refactor we should decide whether they
  stay `local` (presentation bucket) or get a new provenance like
  `mcp-bridge-control` with a codemode bucket of `local`. This decision
  affects the event payloads consumers see.
- **Event consumers.** `tools:registered` / `tools:unregistered` carry
  `source` today. Anyone subscribing and pattern-matching on `source.kind`
  has the same exhaustiveness concern as codemode. Inventory before
  finalizing step 1.

## Not Done In This Session

The current session is a documentation / import-path polish pass. Loosening
`ToolSource` is a coordinated cross-plugin contract change and needs:

- A contract-change doc against `llm-tools-registry` covering step 1.
- A contract-change doc against `llm-codemode` covering step 2 (bucket
  policy ownership and fallback decision).
- Coordinated edits in every consumer that currently constructs or pattern-
  matches the union, with the codemode bucket policy landing first or
  simultaneously.
- A decision on `llm-mcp-bridge`'s control-tool provenance.
- A pre-flight grep for any other plugin that re-declares `ToolSource`.

These exceed the scope of a single polish session and should be sequenced
deliberately.
