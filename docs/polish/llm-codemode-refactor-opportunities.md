# llm-codemode Refactor Opportunities

Date: 2026-05-13
Session target: llm-codemode

## Opportunity

The host and the worker each carry their own implementation of the
"group registrations into the closed `kaizen.{tools,mcp,agents,skills,memory}`
namespace tree" logic. The shapes are intentionally identical, but the leaves
differ (host builds direct `(args) => invoke(name, args)` functions; worker
builds `(args) => postMessage(...)` proxies). The two implementations can drift
silently and tests only cover the host copy directly — the worker copy is only
exercised end-to-end.

A secondary opportunity: `maxBlocksPerResponse` is a config key that nothing
reads at runtime. The README admits it is "reserved"; `config.ts` still
validates that it is `> 0` and `index.ts` still passes it into
`formatToolResult`, but `formatToolResult` never consults it. Either delete the
key or wire it up; carrying a validated-but-unused key is a footgun.

## Evidence

Parallel grouping logic:

- `plugins/llm-codemode/sandbox-host.ts` — `buildKaizenGlobal({ registrations, invoke })`.
  Builds the nested namespace tree from `ToolRegistration[]` using `bucketFor`.
  Exported from `sandbox-host.ts` but **not invoked by `runInSandbox`** in
  production. It is only exercised by `test/sandbox-host-grouped.test.ts`.
- `plugins/llm-codemode/sandbox-entry.ts` — `makeKaizen(registrations)`. Same
  bucketing via the shared `buckets.ts`, but each leaf is an `invokeFn(name)`
  that posts a `tool-invoke` message. This is the implementation the LLM
  actually sees inside the sandbox.
- `plugins/llm-codemode/buckets.ts` already isolates the bucket policy as a
  runtime-free module, so the namespace-tree builder can be factored out the
  same way.

Symptom of drift risk: the host-side test asserts
`kaizen.mcp.cloudflare_fs.ping` reaches `invoke`, but the production behavior
lives in `makeKaizen` (worker), which has no equivalent direct test — only the
`e2e-sandbox` tests, which use single-server scenarios. A change to
`buildKaizenGlobal`'s shape would not flag a divergence in `makeKaizen`.

Dead config key:

- `plugins/llm-codemode/config.ts` — `DEFAULT_CONFIG.maxBlocksPerResponse = 8`
  and `validate()` rejects `<= 0`.
- `plugins/llm-codemode/serialize.ts` — `formatToolResult` accepts
  `caps.maxBlocksPerResponse` but never references it. `FormatInput` has an
  `ignoredBlocks` field that is also unused.
- `plugins/llm-codemode/index.ts` — passes the cap through to
  `formatToolResult`.

## Scope

- Local to this plugin or cross-plugin: **Local.** Both items live entirely
  inside `llm-codemode`.
- Affected openai-compatible plugins: none directly. The grouping shape is the
  one rendered into the `execute_typescript` tool description and the one
  exposed inside the sandbox; both originate from this plugin.
- Related contracts: `ToolSource` (open shape, owned by `llm-tools-registry`)
  and `CodemodeBucket` (closed shape, owned here). Neither contract needs to
  change.

## Suggested Direction

1. Introduce a runtime-free helper (e.g. `kaizen-tree.ts`) that takes a
   `ReadonlyArray<{ name: string; source: ToolSource }>` and a
   `leaf: (name: string) => T`, and returns the nested namespace tree shape.
   It is the single source of truth for how registrations turn into the
   `{ tools?, mcp?, agents?, skills?, memory? }` layout.
2. `buildKaizenGlobal` in `sandbox-host.ts` becomes a thin wrapper:
   `buildTree(regs.map(r => ({ name: r.schema.name, source: r.source })),
   (name) => (a) => invoke(name, a))`.
3. `makeKaizen` in `sandbox-entry.ts` becomes the same wrapper with
   `(name) => invokeFn(name)`.
4. Add a focused test that locks the tree shape (an MCP server, an agent, a
   skill, and a memory tool in one fixture) and exercises both wrappers
   against it. Drift between host and worker becomes visible at test time.
5. Decide on `maxBlocksPerResponse`. Recommended: drop the key. Remove the
   validator branch, remove the field from the cap shape passed to
   `formatToolResult`, remove the README row, document the removal in a
   `llm-codemode-contract-change.md`. If we instead keep it for forward
   compat, at minimum add a clarifying comment and stop threading it through
   `formatToolResult`.

Migration / sequencing notes:

- The tree helper change is purely additive: introduce the helper, replace
  both call sites, delete the duplicated logic. The wire format
  (`RegistrationMeta[]` over `postMessage`) does not change.
- The config-key change is observable to anyone who sets
  `maxBlocksPerResponse` in `~/.kaizen/plugins/llm-codemode/config.json`.
  Today it has no effect; after removal the validator would still accept it
  if we keep `{ ...DEFAULT_CONFIG, ...parsed }` (extra keys flow through).
  Decide whether to actively reject unknown keys or quietly ignore them.

Risks:

- Subtle: today `makeKaizen` falls back to a fully-lazy `kaizen.tools.*`
  proxy when `registrations` is empty (preserved for legacy / no-listRegistrations
  callers). The host helper has no such fallback. The shared helper must keep
  the fallback path on the sandbox side only, or the fallback must be moved
  into `sandbox-entry.ts` outside the shared helper. Recommend: keep the
  fallback in the worker entry, around the call to the shared helper, so the
  shared helper stays free of policy.

## Resolution

Both opportunities were executed in the same session at the user's request
(scope extended past the default "small, local" polish rule):

- `kaizen-tree.ts` introduced as the runtime-free shared grouping helper.
  `buildKaizenGlobal` (host) and `makeKaizen` (worker) both route through it.
  The worker keeps its empty-registrations lazy-proxy fallback at the call
  site so the shared helper stays policy-free.
- `test/kaizen-tree.test.ts` added as the shape-locking test covering every
  bucket kind, normalization, and the unknown-kind fallback in one pass.
- `maxBlocksPerResponse` removed from `CodeModeConfig`, `validate()`,
  `FormatInput`, and `formatToolResult`'s `caps`. Unknown keys in user
  `config.json` continue to load silently (the loader uses
  `{ ...DEFAULT_CONFIG, ...parsed }`); the validator no longer reads the
  field. Documented as a contract change in
  `docs/polish/llm-codemode-contract-change.md` (0.3.0 section).

Plugin bumped 0.2.0 → 0.3.0; harness coordinate and marketplace entry
updated. `bun test plugins/llm-codemode` 81/81 pass; full repo `bun test`
1179/0 fail.
