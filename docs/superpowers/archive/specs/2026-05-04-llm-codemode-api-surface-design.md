# Code-Mode API Surface Assembly (Spec 15)

> **Note:** This spec extends Spec 5 (`llm-codemode-dispatch`) with the cross-provider assembly model required by Spec 14 (`llm-system-prompt`). Where this spec contradicts Spec 5's `prepareRequest`/`systemPromptAppend` flow, this spec wins; Spec 5 is treated as archival.

**Status:** draft
**Date:** 2026-05-04
**Tier:** 2 (B milestone — gates anything that wants tools to be visible to the model)
**Depends on:** Spec 0 (`tools:registry`, `tool-dispatch:strategy`), Spec 5 (existing DTS renderer + sandbox), Spec 14 (`prompt:system`)
**Provides section:** `llm-codemode-dispatch:api` registered into `prompt:system` at priority `100`
**Scope:** Specifies how tools registered in `tools:registry` from multiple sources (local tools, MCP servers, agents-as-tools) are assembled into the single `.d.ts` API surface visible to the LLM in code-mode. Replaces the `systemPromptAppend` return path with a `prompt:system` section. Defines namespacing for cross-provider tools, doc-comment composition, change detection, and ordering determinism.

## Goal

The LLM in code-mode sees one `.d.ts` block declaring the entire `kaizen` global. Today (Spec 5) that block is built from a flat `availableTools: ToolSchema[]` list returned by `tools:registry.list()` and emitted via `systemPromptAppend` once per turn. As `llm-mcp-bridge` (Spec 11) and `llm-agents` (Spec 10) come online, that flat namespace becomes:

- ambiguous (`mcp:filesystem` and `mcp:cloudflare-fs` may both expose `read_file`)
- noisy (one MCP server can register dozens of tools, drowning the local-tool surface)
- expensive to re-render every turn

This spec defines the assembly model that fixes those three things and integrates with the prefix-cache strategy from Spec 14.

## Non-goals

- Replacing the DTS renderer. Spec 5's `json-schema-to-typescript`-based renderer continues to handle individual schemas.
- Replacing the sandbox runtime, the code-block extractor, or the tool-result feedback path. Those stay as Spec 5 specifies.
- Defining how MCP servers are discovered or connected — that is Spec 11.
- Token budgeting / truncation of the API surface when the tool count is huge. Out of scope for v0; flagged as an open question.

## Architectural overview

```
┌──────────────────────────────────────────────────────────────────┐
│ tools:registry  (Spec 0)                                         │
│   register({ schema, handler, source?, namespace? })             │
│   list() → ToolSchema[] (with provenance)                        │
└────────────┬─────────────────────────────────────────────────────┘
             │
             │ subscribes to register/unregister
             ▼
┌──────────────────────────────────────────────────────────────────┐
│ llm-codemode-dispatch (this plugin, extended)                    │
│                                                                  │
│   ┌──────────────────────────────┐                               │
│   │ Assembly                     │                               │
│   │  - groups tools by namespace │                               │
│   │  - renders DTS per namespace │                               │
│   │  - composes the kaizen global│                               │
│   │  - caches by surface-hash    │                               │
│   └─────────────┬────────────────┘                               │
│                 │                                                │
│                 │ on change: section.bumpGeneration()            │
│                 ▼                                                │
│   prompt:system.register({                                       │
│     id: "llm-codemode-dispatch:api",                             │
│     priority: 100,                                               │
│     render: () => <cached .d.ts + preamble>                      │
│   })                                                             │
└──────────────────────────────────────────────────────────────────┘
```

`prepareRequest` from Spec 5 is preserved for `llm-native-dispatch` parity but in code-mode it returns `{}` — the system prompt is now contributed via `prompt:system`, not via `systemPromptAppend`. See *Migration* below.

## Tool source provenance

Spec 0's `ToolSchema` has only `{ name, description, parameters, tags? }`. To assemble per-source, the registry needs provenance. The change is additive:

```ts
export interface ToolSchema {
  name: string;
  description: string;
  parameters: JSONSchema7;
  tags?: string[];
}

// NEW (additive — registry passes this alongside the schema, not embedded in it):
export interface ToolRegistration {
  schema: ToolSchema;
  handler: ToolHandler;
  /**
   * Logical source. Drives namespacing in the code-mode API surface.
   * Examples:
   *   { kind: "local" }                                        // → kaizen.tools.<name>
   *   { kind: "mcp", server: "filesystem" }                    // → kaizen.mcp.filesystem.<name>
   *   { kind: "agent" }                                        // → kaizen.agents.<name>
   *   { kind: "skill" }                                        // → kaizen.skills.<name>  (load_skill, list_skills live here)
   *   { kind: "memory" }                                       // → kaizen.memory.<name>
   */
  source: ToolSource;
}

export type ToolSource =
  | { kind: "local" }
  | { kind: "mcp"; server: string }
  | { kind: "agent" }
  | { kind: "skill" }
  | { kind: "memory" };

export interface ToolsRegistryService {
  register(reg: ToolRegistration): () => void;
  // ... rest unchanged from Spec 0
  list(filter?: { tags?: string[]; names?: string[]; sources?: ToolSource["kind"][] }): ToolRegistration[];
}
```

Existing callers that pass `(schema, handler)` get a default `source: { kind: "local" }`. The registry adapter accepts both shapes for one minor version, then drops the legacy form.

## Namespace mapping

The `kaizen` global produced by the assembler:

```ts
declare const kaizen: {
  /** Tools registered locally by plugins (default plugin tools, slash-command-side helpers, etc.). */
  tools: { /* name → method */ };

  /** Tools provided by MCP servers, grouped per server. */
  mcp: {
    [server: string]: { /* name → method */ };
  };

  /** Subagent dispatch — agents registered into agents:registry, surfaced as callable tools. */
  agents: { /* name → method */ };

  /** Skill discovery + loading — load_skill, list_skills live here. */
  skills: { /* name → method */ };

  /** Memory recall + save — memory_recall, memory_save live here. */
  memory: { /* name → method */ };
};
```

### Why grouped, not flat

A flat `kaizen.tools.*` would make MCP collisions silent and would let one MCP server's surface dominate the visible namespace. Grouping:

- **Disambiguates by construction.** `kaizen.mcp.filesystem.read_file` and `kaizen.mcp.cloudflare_fs.read_file` cannot collide.
- **Lets the LLM scan capabilities by category.** The model reads "I have local tools, MCP servers X/Y/Z, agents, skills, memory" without parsing names.
- **Bounds the prompt-cache blast radius.** Adding an MCP server changes only the `kaizen.mcp.<server>` subtree; the rest of the surface keeps its byte-identical rendering.

### Server name normalization

MCP server names come from `~/.kaizen/mcp/servers.json`. They may contain hyphens, dots, or other non-identifier characters. The assembler normalizes:

| Input | Normalized | Rule |
|---|---|---|
| `filesystem` | `filesystem` | already valid |
| `cloudflare-fs` | `cloudflare_fs` | hyphens → underscores |
| `taxhawk.docs` | `taxhawk_docs` | dots → underscores |
| `2024-stuff` | `_2024_stuff` | leading digit gets `_` prefix |
| `Filesystem` | `Filesystem` | case preserved |

If two server names normalize to the same identifier, the second registration is rejected and an `mcp:registration-conflict` event fires (defined in Spec 11). The user sees a TUI warning; the conflicting server is not surfaced.

### Tool name normalization (within a namespace)

Spec 5 already handles this: tool names that are not valid TS identifiers render with bracket syntax (`"web-search"(args: ...): Promise<...>`). That rule is preserved unchanged. The sandbox host exposes the raw name as the property key.

## Section composition

The single section registered into `prompt:system` (id `llm-codemode-dispatch:api`, priority `100`) renders this string structure:

```
## Tools (code-mode)

You have access to a sandboxed TypeScript runtime. To call tools, write a single
```typescript code block. The value of the last expression (or any explicit
`return` from a top-level async IIFE) is returned to you. Use console.log for
intermediate output.

The following API is available:

```typescript
declare const kaizen: {
  tools: {
    /** {description from schema} */
    {name}(args: {ParamsName}): Promise<unknown>;
    ...
  };
  mcp: {
    filesystem: {
      /** {description} */
      read_file(args: { path: string }): Promise<unknown>;
      ...
    };
    ...
  };
  agents: { ... };
  skills: { ... };
  memory: { ... };
};

// Param type interfaces follow:
interface {ParamsName} { ... }
...
```

Empty namespaces (e.g., no MCP servers configured) are omitted entirely from the `kaizen` global declaration — no `mcp: {}` placeholder.
```

### Header / preamble

The preamble (the natural-language instructions before the `.d.ts` block) is invariant; it does not change as tools are added or removed. Caching exploits this — see *Caching*.

### Doc-comment rules

Per-method JSDoc is composed from the tool's `description` field. Composition rules:

1. If `description` is empty or absent → no JSDoc emitted.
2. If `description` is single-line → one-line JSDoc (`/** ... */`).
3. If `description` is multi-line → multi-line JSDoc with each input line prefixed by ` * `.
4. JSDoc tags are NOT inferred from the schema (no auto-`@param`). The schema-derived TS types already convey types; duplicating them as `@param` doubles the token cost without helping the model.
5. If the tool has `tags?: string[]`, they are rendered as a trailing `@tags` line: `* @tags read,fs`. Used by the model to filter capabilities; cheap to render.

## Caching and change detection

Rendering 50+ tools through `json-schema-to-typescript` is not free, and rendering it on every turn is wasteful. The assembler caches at two layers:

### Layer 1: per-tool rendering

Keyed on `hash(name + JSON.stringify(parameters) + description + tags)`. The library output is deterministic, so an unchanged schema produces a byte-identical interface and method declaration. Cache lifetime: process lifetime; entries are evicted only when the tool is unregistered.

### Layer 2: surface-level rendering

Keyed on the sorted list of layer-1 cache hits. Identical tool sets in identical order produce a byte-identical `.d.ts`. The cache stores the assembled string and the surface hash. The section's `render()` returns the cached string directly when the hash is unchanged.

### Triggering `bumpGeneration`

The assembler subscribes to `tools:registry`'s mutation events (added in Spec 0 amendment, see *Spec 0 amendments* below):

| Event | Payload | Action |
|---|---|---|
| `tools:registered` | `{ name, source }` | Recompute layer-2 hash; if changed, call `section.bumpGeneration()` on the handle returned by the section's `prompt:system.register()` |
| `tools:unregistered` | `{ name, source }` | Same |

Description-only changes (rare, but possible if a plugin re-registers with a tweaked description) also trigger a bump because layer-1 hash includes description.

### Determinism

Sort order within each namespace is locale-independent ASCII sort by tool name. Sort order of MCP servers is the same. The local-tool list, MCP server list, agents list, skills list, memory list each render in their own block. Top-level keys of the `kaizen` global render in this fixed order: `tools`, `mcp`, `agents`, `skills`, `memory`. Empty groups are omitted (see above).

This determinism is required: any non-determinism in this rendering breaks the prefix cache for users on every restart.

## Migration from Spec 5's `systemPromptAppend`

Spec 5 defines:

```ts
prepareRequest({ availableTools }) {
  return { systemPromptAppend: <rendered .d.ts> };
}
```

Spec 14 makes this redundant — the system prompt is now assembled via `prompt:system`. Migration:

1. The plugin still implements `tool-dispatch:strategy.prepareRequest`, but it now returns `{}`.
2. At plugin start, the plugin registers its section with `prompt:system.register({ id: "llm-codemode-dispatch:api", priority: 100, render })`.
3. The `availableTools` argument that `prepareRequest` formerly received is replaced by a direct read of `tools:registry.list()` inside `render()`. (Per-turn filtering by the driver — restricting the visible toolset for a recursive `driver:run-conversation` call — is preserved by the driver setting a thread-local filter that `tools:registry.list()` honors. Spec 0's `RunConversationInput.toolFilter` semantics are unchanged.)

The transitional path: for one minor version, `prepareRequest` still returns `systemPromptAppend` if no `prompt:system` service is registered, so installs that have not pulled in `llm-system-prompt` keep working. Once `llm-system-prompt` is universal in the harness, the legacy path is dropped.

## Spec 0 amendments

This spec implies two changes to Spec 0 contracts:

1. `ToolsRegistryService.register` accepts `ToolRegistration` (with `source`) in addition to the legacy `(schema, handler)` shape. Default source on the legacy path is `{ kind: "local" }`.
2. New events `tools:registered` and `tools:unregistered` join the event vocabulary, fired by the registry on mutation.

Both are additive — no existing caller breaks.

## Sandbox-side mapping

Spec 5 exposes `globalThis.kaizen.tools.<name>` and routes calls through `registry.invoke(name, args, ctx)`. With grouping, the sandbox host now exposes:

- `kaizen.tools.<name>` → `registry.invoke(name, args, { ...ctx })` (source: local)
- `kaizen.mcp.<server>.<name>` → `registry.invoke(qualifiedName, args, { ...ctx })`
- `kaizen.agents.<name>` → `registry.invoke(qualifiedName, args, { ...ctx })`
- `kaizen.skills.<name>` → same
- `kaizen.memory.<name>` → same

Where `qualifiedName` is the registry-internal canonical name. The registry's canonical name format is implementation detail; the convention `<source-kind>:<server-or-empty>:<name>` is suggested but not contractual. What is contractual: each registered tool has exactly one canonical name in the registry, and the assembler maps grouped paths to canonical names through a lookup table built at section-render time.

## Token-budget pressure (open question)

A user with 30 MCP servers and 200 total tools will produce a large `.d.ts`. v0 emits all of it. The cache hit rate is unaffected — it's the same surface every turn — but the absolute token cost may be high.

v1 ideas (deferred):

- **Tag-based filter sections.** Multiple section registrations, each filtered by tag, only emitting the relevant subset based on a per-turn hint. Loses prefix-cache friendliness; probably not worth it.
- **Just-in-time MCP namespace expansion.** Surface only the MCP server *names* in the system prompt; require the LLM to call `kaizen.mcp.<server>.list()` to see tools. Reduces the steady-state surface dramatically; costs one extra turn when the model wants to use an MCP. Plausible if surfaces grow beyond ~8k tokens.
- **User opt-out per server.** Config flag in `~/.kaizen/mcp/servers.json` to omit a server from the API surface entirely (still callable explicitly via a `kaizen.mcp.invoke(server, name, args)` escape hatch).

For v0 the recommendation is: just emit the full surface and rely on prefix caching to amortize the cost.

## File layout

The implementation lives inside the existing `llm-codemode-dispatch` plugin; no new plugin is needed. New / changed files:

```
plugins/llm-codemode-dispatch/
  src/
    assembler.ts       # NEW — namespace grouping, surface hash, section render
    section.ts         # NEW — registers with prompt:system
    dts-renderer.ts    # existing (Spec 5)
    sandbox-host.ts    # existing — extended to expose grouped namespaces
    index.ts           # extended — wires assembler + section into startup
```

## Acceptance criteria

1. With only local tools registered, the `.d.ts` block contains a `kaizen.tools` namespace and no others.
2. With MCP servers `filesystem` and `cloudflare-fs` each exposing a `read_file` tool, both render under their own namespace and there is no collision.
3. Adding a tool fires `tools:registered`, which fires `prompt:rebuilt`, which causes the driver to drop its cached system prompt; the next LLM call sees the new tool.
4. Two consecutive renders with no tool changes return the same string instance — verified by identity comparison in tests.
5. A user with no MCP servers, agents, or skills sees only `tools` in the `kaizen` declaration; no empty `{}` placeholders.
6. Server name `cloudflare-fs` renders as `kaizen.mcp.cloudflare_fs.*`; sandbox `kaizen.mcp.cloudflare_fs.read_file({path})` calls succeed.
7. Two MCP servers normalizing to the same identifier produce one registration and one `mcp:registration-conflict` event; the second server's tools are absent from the surface.
