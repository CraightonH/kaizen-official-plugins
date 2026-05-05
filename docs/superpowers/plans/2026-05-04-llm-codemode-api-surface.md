# Code-Mode API Surface Assembly Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Spec 15 (`docs/superpowers/specs/2026-05-04-llm-codemode-api-surface-design.md`) — extend the tools registry to track per-tool provenance (`source: ToolSource`), refactor `llm-codemode-dispatch` to assemble a grouped `kaizen` global namespace (`tools` / `mcp` / `agents` / `skills` / `memory`) instead of a flat one, register the assembled API surface as a `prompt:system` section at priority 100, and migrate from `prepareRequest`'s `systemPromptAppend` return path to the section-registry path. MCP server name normalization, two-layer rendering cache, and deterministic ordering are required so the prefix cache stays warm.

**Architecture:** Two cooperating plugins are modified — no new plugin. `llm-tools-registry` gains an additive `ToolRegistration` API (legacy `(schema, handler)` still accepted, defaults `source: { kind: "local" }`) and emits `tools:registered` / `tools:unregistered`. `llm-codemode-dispatch` gains an `assembler.ts` (groups by source, renders DTS per namespace, two-layer cache) and a `section.ts` (registers with `prompt:system` at priority 100, subscribes to registry events to bump generation). `prepareRequest` returns `{}` when `prompt:system` is available; legacy `systemPromptAppend` path is preserved as fallback. `sandbox-host.ts` is extended to expose grouped namespaces (`kaizen.mcp.<server>.<tool>` etc.), routing all calls back through `registry.invoke(canonicalName, args, ctx)`.

**Tech Stack:** TypeScript, Bun runtime. Existing dep on `json-schema-to-typescript` (v0 codemode dispatch) is reused. Tests use `bun:test`. Depends on Spec 14's `prompt:system` service being deployed.

---

## Prerequisites

This plan REQUIRES the `llm-system-prompt` plan (`2026-05-04-llm-system-prompt.md`) to be completed first. The new plugin must be in the marketplace and harness, and the driver's generation-keyed cache must be live, otherwise the `prompt:system` integration here is untestable end-to-end.

## Tier-for-Parallelism Map

- **Tier 0** (sequential, blocks all others): Task 1 (registry: add ToolSource + ToolRegistration types).
- **Tier 1** (parallel after Tier 0): Task 2 (registry: rewrite `register` + emit events), Task 3 (vocab additions in `llm-events`).
- **Tier 2** (parallel): Task 4 (`assembler.ts` — pure grouping/rendering/hashing), Task 5 (`section.ts` — section factory).
- **Tier 3** (sequential): Task 6 (wire in `llm-codemode-dispatch/index.ts`), Task 7 (sandbox grouped-namespace exposure), Task 8 (deprecate `systemPromptAppend` return).
- **Tier 4** (sequential): Task 9 (e2e smoke).

## File Structure

```
plugins/llm-tools-registry/
  registry.ts              # MODIFY — accept ToolRegistration; emit tools:registered/unregistered
  public.d.ts              # MODIFY — add ToolSource and ToolRegistration types
  test/registry-source.test.ts  # NEW — provenance + events

plugins/llm-events/
  index.ts                 # MODIFY — add TOOLS_REGISTERED, TOOLS_UNREGISTERED to VOCAB
  public.d.ts              # MODIFY — add to Vocab interface
  index.test.ts            # MODIFY — assert new vocab keys

plugins/llm-codemode-dispatch/
  assembler.ts             # NEW — groupBySource(), surfaceHash(), renderSurface()
  section.ts               # NEW — makeApiSurfaceSection(registry, eventBus): SystemPromptSection
  sandbox-host.ts          # MODIFY — expose grouped namespaces under kaizen.mcp/agents/skills/memory
  index.ts                 # MODIFY — register section via prompt:system; prepareRequest returns {} when service is present
  prepare-request.ts       # MODIFY — gated on absence of prompt:system service
  test/assembler.test.ts   # NEW
  test/section.test.ts     # NEW
  test/sandbox-host-grouped.test.ts  # NEW
```

Boundaries:
- `assembler.ts` is pure — input is `ToolRegistration[]`, output is the rendered `.d.ts` string + a content hash. No I/O, no event subscriptions.
- `section.ts` is the only module that touches `prompt:system`. It owns the `RegisteredSection` handle and the `tools:registered`/`tools:unregistered` subscriptions that drive `bumpGeneration()`.
- Tools registry behavior change is purely additive — the legacy `(schema, handler)` signature continues to work and defaults to `source: { kind: "local" }`.

---

## Task 1: Add `ToolSource` + `ToolRegistration` to `llm-tools-registry/public.d.ts`

**Files:**
- Modify: `plugins/llm-tools-registry/public.d.ts`

- [ ] **Step 1: Inspect current public.d.ts**

Run: `cat plugins/llm-tools-registry/public.d.ts`
Note the current `ToolsRegistryService` interface so the new shape is purely additive.

- [ ] **Step 2: Write the failing test**

Append to `plugins/llm-tools-registry/test/registry.test.ts` (existing file):

```typescript
import type { ToolSource, ToolRegistration } from "../public";

describe("public types — ToolSource", () => {
  it("admits all spec'd source kinds", () => {
    const a: ToolSource = { kind: "local" };
    const b: ToolSource = { kind: "mcp", server: "filesystem" };
    const c: ToolSource = { kind: "agent" };
    const d: ToolSource = { kind: "skill" };
    const e: ToolSource = { kind: "memory" };
    expect([a, b, c, d, e].every(Boolean)).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd plugins/llm-tools-registry && bun test`
Expected: FAIL — `Cannot find module '../public'` for the new types.

- [ ] **Step 4: Add the types**

In `plugins/llm-tools-registry/public.d.ts`, append (preserving existing exports):

```typescript
export type ToolSource =
  | { kind: "local" }
  | { kind: "mcp"; server: string }
  | { kind: "agent" }
  | { kind: "skill" }
  | { kind: "memory" };

export interface ToolRegistration {
  schema: import("./public").ToolSchema;
  handler: import("./public").ToolHandler;
  source: ToolSource;
}
```

(If `ToolSchema` and `ToolHandler` are already top-level exports in this file, drop the `import("./public").` qualifiers.)

- [ ] **Step 5: Run test to verify it passes**

Run: `cd plugins/llm-tools-registry && bun test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add plugins/llm-tools-registry/public.d.ts plugins/llm-tools-registry/test/registry.test.ts
git commit -m "feat(llm-tools-registry): add ToolSource and ToolRegistration types (Spec 15)"
```

---

## Task 2: Extend `register` to accept `ToolRegistration` and emit events

**Files:**
- Modify: `plugins/llm-tools-registry/registry.ts`
- Modify: `plugins/llm-tools-registry/test/registry.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `plugins/llm-tools-registry/test/registry.test.ts`:

```typescript
import { mock } from "bun:test";
import { makeRegistry } from "../registry.ts";

describe("registry — provenance", () => {
  it("legacy register(schema, handler) defaults source to { kind: 'local' }", () => {
    const emit = mock(async () => []);
    const r = makeRegistry(emit as any);
    r.register({ name: "t", description: "", parameters: { type: "object" } as any }, async () => "ok");
    const reg = r.listRegistrations()[0];
    expect(reg!.source).toEqual({ kind: "local" });
  });

  it("new registerWith(reg) keeps the supplied source", () => {
    const emit = mock(async () => []);
    const r = makeRegistry(emit as any);
    r.registerWith({
      schema: { name: "t", description: "", parameters: { type: "object" } as any },
      handler: async () => "ok",
      source: { kind: "mcp", server: "filesystem" },
    });
    const reg = r.listRegistrations()[0];
    expect(reg!.source).toEqual({ kind: "mcp", server: "filesystem" });
  });

  it("registering emits tools:registered with name and source", async () => {
    const emit = mock(async () => []);
    const r = makeRegistry(emit as any);
    r.registerWith({
      schema: { name: "t", description: "", parameters: { type: "object" } as any },
      handler: async () => "ok",
      source: { kind: "agent" },
    });
    expect(emit).toHaveBeenCalledWith("tools:registered", { name: "t", source: { kind: "agent" } });
  });

  it("unregistering (via the returned closure) emits tools:unregistered", async () => {
    const emit = mock(async () => []);
    const r = makeRegistry(emit as any);
    const off = r.registerWith({
      schema: { name: "t", description: "", parameters: { type: "object" } as any },
      handler: async () => "ok",
      source: { kind: "skill" },
    });
    emit.mockClear();
    off();
    expect(emit).toHaveBeenCalledWith("tools:unregistered", { name: "t", source: { kind: "skill" } });
  });

  it("list(filter.sources) restricts by kind", () => {
    const r = makeRegistry(mock(async () => []) as any);
    r.registerWith({
      schema: { name: "a", description: "", parameters: { type: "object" } as any },
      handler: async () => null, source: { kind: "local" },
    });
    r.registerWith({
      schema: { name: "b", description: "", parameters: { type: "object" } as any },
      handler: async () => null, source: { kind: "mcp", server: "fs" },
    });
    const onlyMcp = r.list({ sources: ["mcp"] });
    expect(onlyMcp.map((s) => s.name)).toEqual(["b"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd plugins/llm-tools-registry && bun test`
Expected: FAIL — `registerWith`, `listRegistrations`, source-filter, and event-emission don't exist.

- [ ] **Step 3: Implement the registry changes**

Replace `plugins/llm-tools-registry/registry.ts` with:

```typescript
import type {
  ToolRegistration,
  ToolSchema,
  ToolSource,
} from "./public";

const CANCEL_TOOL: unique symbol = Symbol.for("kaizen.cancel") as never;

export interface ToolExecutionContext {
  signal: AbortSignal;
  callId: string;
  turnId?: string;
  log: (msg: string) => void;
}

export type ToolHandler = (args: unknown, ctx: ToolExecutionContext) => Promise<unknown>;

export interface ToolsRegistryService {
  /** Legacy form. Defaults source to { kind: "local" }. */
  register(schema: ToolSchema, handler: ToolHandler): () => void;
  /** Spec 15 form. Caller controls source. */
  registerWith(reg: ToolRegistration): () => void;
  list(filter?: { tags?: string[]; names?: string[]; sources?: ToolSource["kind"][] }): ToolSchema[];
  /** Includes provenance; used by code-mode assembler. */
  listRegistrations(filter?: { tags?: string[]; names?: string[]; sources?: ToolSource["kind"][] }): ToolRegistration[];
  invoke(name: string, args: unknown, ctx: ToolExecutionContext): Promise<unknown>;
}

interface Entry { schema: ToolSchema; handler: ToolHandler; source: ToolSource; }

type Emit = (event: string, payload: unknown) => Promise<unknown[]>;

export function makeRegistry(emit: Emit): ToolsRegistryService {
  const entries = new Map<string, Entry>();

  function registerWith(reg: ToolRegistration): () => void {
    const { schema, handler, source } = reg;
    if (typeof schema.name !== "string" || schema.name.length === 0) {
      throw new Error("ToolSchema.name must be a non-empty string");
    }
    if (entries.has(schema.name)) {
      throw new Error(`tool already registered: ${schema.name}`);
    }
    const entry: Entry = { schema, handler, source };
    entries.set(schema.name, entry);
    void emit("tools:registered", { name: schema.name, source });
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      const cur = entries.get(schema.name);
      if (cur === entry) {
        entries.delete(schema.name);
        void emit("tools:unregistered", { name: schema.name, source });
      }
    };
  }

  function register(schema: ToolSchema, handler: ToolHandler): () => void {
    return registerWith({ schema, handler, source: { kind: "local" } });
  }

  function matchesFilter(entry: Entry, filter?: { tags?: string[]; names?: string[]; sources?: ToolSource["kind"][] }): boolean {
    if (!filter) return true;
    if (filter.names) {
      const nameSet = new Set(filter.names);
      if (!nameSet.has(entry.schema.name)) return false;
    }
    if (filter.tags) {
      const tagSet = new Set(filter.tags);
      const tags = entry.schema.tags ?? [];
      let any = false;
      for (const t of tags) if (tagSet.has(t)) { any = true; break; }
      if (!any) return false;
    }
    if (filter.sources) {
      const set = new Set(filter.sources);
      if (!set.has(entry.source.kind)) return false;
    }
    return true;
  }

  function list(filter?: Parameters<ToolsRegistryService["list"]>[0]): ToolSchema[] {
    const out: ToolSchema[] = [];
    for (const e of entries.values()) {
      if (matchesFilter(e, filter)) out.push(e.schema);
    }
    return out;
  }

  function listRegistrations(filter?: Parameters<ToolsRegistryService["list"]>[0]): ToolRegistration[] {
    const out: ToolRegistration[] = [];
    for (const e of entries.values()) {
      if (matchesFilter(e, filter)) out.push({ schema: e.schema, handler: e.handler, source: e.source });
    }
    return out;
  }

  async function invoke(name: string, args: unknown, ctx: ToolExecutionContext): Promise<unknown> {
    const entry = entries.get(name);
    if (!entry) {
      const message = `unknown tool: ${name}`;
      await emit("tool:error", { name, callId: ctx.callId, message });
      throw new Error(message);
    }
    const beforePayload: { name: string; args: unknown; callId: string } = { name, args, callId: ctx.callId };
    await emit("tool:before-execute", beforePayload);
    if (beforePayload.args === CANCEL_TOOL) {
      const message = "cancelled by subscriber";
      await emit("tool:error", { name, callId: ctx.callId, message });
      const err = new Error(message);
      (err as any).name = "AbortError";
      throw err;
    }
    await emit("tool:execute", { name, args: beforePayload.args, callId: ctx.callId });
    try {
      const result = await entry.handler(beforePayload.args, ctx);
      await emit("tool:result", { name, callId: ctx.callId, result });
      return result;
    } catch (err) {
      const message = String((err as any)?.message ?? err);
      await emit("tool:error", { name, callId: ctx.callId, message, cause: err });
      throw err;
    }
  }

  return { register, registerWith, list, listRegistrations, invoke };
}
```

- [ ] **Step 4: Run tests**

Run: `cd plugins/llm-tools-registry && bun test`
Expected: PASS — both legacy and new tests green.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-tools-registry/registry.ts plugins/llm-tools-registry/test/registry.test.ts
git commit -m "feat(llm-tools-registry): registerWith(ToolRegistration), source filtering, tools:registered/unregistered events"
```

---

## Task 3: Add `tools:registered` + `tools:unregistered` to `llm-events` VOCAB

**Files:**
- Modify: `plugins/llm-events/index.ts`
- Modify: `plugins/llm-events/public.d.ts`
- Modify: `plugins/llm-events/index.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `plugins/llm-events/index.test.ts`:

```typescript
it("VOCAB includes tools:registered and tools:unregistered", () => {
  expect(VOCAB.TOOLS_REGISTERED).toBe("tools:registered");
  expect(VOCAB.TOOLS_UNREGISTERED).toBe("tools:unregistered");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/llm-events && bun test`
Expected: FAIL.

- [ ] **Step 3: Update `public.d.ts` and `index.ts`**

In `plugins/llm-events/public.d.ts`, add to the `Vocab` interface:

```typescript
TOOLS_REGISTERED: "tools:registered";
TOOLS_UNREGISTERED: "tools:unregistered";
```

In `plugins/llm-events/index.ts`, add to the `VOCAB` literal (in the same group as the existing `TOOL_*` keys):

```typescript
  TOOLS_REGISTERED: "tools:registered",
  TOOLS_UNREGISTERED: "tools:unregistered",
```

- [ ] **Step 4: Run tests**

Run: `cd plugins/llm-events && bun test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-events
git commit -m "feat(llm-events): add tools:registered and tools:unregistered to VOCAB"
```

---

## Task 4: Implement `assembler.ts` — grouping, rendering, hashing

**Files:**
- Create: `plugins/llm-codemode-dispatch/assembler.ts`
- Create: `plugins/llm-codemode-dispatch/test/assembler.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `plugins/llm-codemode-dispatch/test/assembler.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { groupBySource, normalizeServerName, surfaceHash, renderSurface } from "../assembler.ts";
import type { ToolRegistration } from "llm-tools-registry/public";

function reg(name: string, source: ToolRegistration["source"], description = ""): ToolRegistration {
  return {
    schema: { name, description, parameters: { type: "object", properties: {} } as any },
    handler: async () => null,
    source,
  };
}

describe("normalizeServerName", () => {
  it("hyphens become underscores", () => {
    expect(normalizeServerName("cloudflare-fs")).toBe("cloudflare_fs");
  });
  it("dots become underscores", () => {
    expect(normalizeServerName("taxhawk.docs")).toBe("taxhawk_docs");
  });
  it("leading digit gets _ prefix", () => {
    expect(normalizeServerName("2024-stuff")).toBe("_2024_stuff");
  });
  it("preserves case", () => {
    expect(normalizeServerName("Filesystem")).toBe("Filesystem");
  });
});

describe("groupBySource", () => {
  it("partitions by source kind, with mcp sub-grouped by server", () => {
    const groups = groupBySource([
      reg("a", { kind: "local" }),
      reg("b", { kind: "mcp", server: "filesystem" }),
      reg("c", { kind: "mcp", server: "filesystem" }),
      reg("d", { kind: "mcp", server: "cloudflare-fs" }),
      reg("e", { kind: "agent" }),
    ]);
    expect(groups.local.map((r) => r.schema.name).sort()).toEqual(["a"]);
    expect(Object.keys(groups.mcp).sort()).toEqual(["cloudflare_fs", "filesystem"]);
    expect(groups.mcp.filesystem!.map((r) => r.schema.name).sort()).toEqual(["b", "c"]);
    expect(groups.agents.map((r) => r.schema.name)).toEqual(["e"]);
  });

  it("MCP server name collisions after normalization are reported", () => {
    const groups = groupBySource([
      reg("a", { kind: "mcp", server: "foo-bar" }),
      reg("b", { kind: "mcp", server: "foo.bar" }),
    ]);
    expect(groups.conflicts.length).toBe(1);
    expect(groups.conflicts[0]!.normalized).toBe("foo_bar");
  });
});

describe("surfaceHash", () => {
  it("identical input → identical hash", () => {
    const list = [reg("a", { kind: "local" }, "x")];
    expect(surfaceHash(list)).toBe(surfaceHash([...list]));
  });
  it("description change → different hash", () => {
    expect(surfaceHash([reg("a", { kind: "local" }, "x")])).not.toBe(
      surfaceHash([reg("a", { kind: "local" }, "y")]),
    );
  });
  it("ordering does not change hash (sorted internally)", () => {
    const a = reg("a", { kind: "local" });
    const b = reg("b", { kind: "local" });
    expect(surfaceHash([a, b])).toBe(surfaceHash([b, a]));
  });
});

describe("renderSurface", () => {
  it("emits only namespaces that have entries", async () => {
    const out = await renderSurface([reg("a", { kind: "local" })]);
    expect(out).toContain("kaizen.tools");
    expect(out).not.toContain("kaizen.mcp");
    expect(out).not.toContain("kaizen.agents");
  });
  it("groups MCP tools under kaizen.mcp.<normalized-server>", async () => {
    const out = await renderSurface([
      reg("read_file", { kind: "mcp", server: "filesystem" }),
      reg("read_file", { kind: "mcp", server: "cloudflare-fs" }),
    ]);
    expect(out).toContain("filesystem:");
    expect(out).toContain("cloudflare_fs:");
  });
  it("includes the preamble and a fenced typescript block", async () => {
    const out = await renderSurface([reg("a", { kind: "local" })]);
    expect(out).toContain("```typescript");
    expect(out).toMatch(/sandboxed TypeScript runtime/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd plugins/llm-codemode-dispatch && bun test test/assembler.test.ts`
Expected: FAIL — `Cannot find module '../assembler.ts'`.

- [ ] **Step 3: Implement `assembler.ts`**

Create `plugins/llm-codemode-dispatch/assembler.ts`:

```typescript
import { createHash } from "node:crypto";
import type { ToolRegistration, ToolSource } from "llm-tools-registry/public";
import { renderToolsDts } from "./dts-render.ts";

const PREAMBLE =
  "You have access to a sandboxed TypeScript runtime. To use a tool, write a single ```typescript code block. " +
  "The code is executed in order; the value of the last expression (or any explicit `return` from a top-level " +
  "statement) is returned to you as the tool result. Use `console.log` to surface intermediate output. " +
  "Only one set of ```typescript blocks per turn will be executed; if you write none, your reply is treated as a " +
  "final answer to the user.\n\n" +
  "After you emit a code block, you will see a message from the user starting with `[code execution result]`. " +
  "Treat it as the runtime's response, not a new request from the human.";

export function normalizeServerName(name: string): string {
  let n = name.replace(/[^A-Za-z0-9_]/g, "_");
  if (/^[0-9]/.test(n)) n = `_${n}`;
  return n;
}

export interface SurfaceGroups {
  local: ToolRegistration[];
  mcp: Record<string, ToolRegistration[]>;
  agents: ToolRegistration[];
  skills: ToolRegistration[];
  memory: ToolRegistration[];
  conflicts: Array<{ normalized: string; servers: string[] }>;
}

export function groupBySource(regs: ReadonlyArray<ToolRegistration>): SurfaceGroups {
  const groups: SurfaceGroups = {
    local: [],
    mcp: {},
    agents: [],
    skills: [],
    memory: [],
    conflicts: [],
  };
  // Track which raw server names landed in each normalized bucket so we can detect collisions.
  const normalizedToRaw = new Map<string, Set<string>>();

  for (const r of regs) {
    const s = r.source as ToolSource;
    switch (s.kind) {
      case "local":
        groups.local.push(r);
        break;
      case "mcp": {
        const norm = normalizeServerName(s.server);
        if (!groups.mcp[norm]) groups.mcp[norm] = [];
        groups.mcp[norm]!.push(r);
        if (!normalizedToRaw.has(norm)) normalizedToRaw.set(norm, new Set());
        normalizedToRaw.get(norm)!.add(s.server);
        break;
      }
      case "agent":
        groups.agents.push(r);
        break;
      case "skill":
        groups.skills.push(r);
        break;
      case "memory":
        groups.memory.push(r);
        break;
    }
  }

  for (const [norm, raws] of normalizedToRaw) {
    if (raws.size > 1) {
      groups.conflicts.push({ normalized: norm, servers: [...raws] });
    }
  }

  return groups;
}

function sortByName(arr: ToolRegistration[]): ToolRegistration[] {
  return [...arr].sort((a, b) => a.schema.name.localeCompare(b.schema.name, "en", { sensitivity: "base" }));
}

export function surfaceHash(regs: ReadonlyArray<ToolRegistration>): string {
  const sorted = sortByName([...regs]);
  const canonical = sorted.map((r) => ({
    name: r.schema.name,
    description: r.schema.description ?? "",
    tags: r.schema.tags ?? [],
    source: r.source,
    parameters: r.schema.parameters ?? null,
  }));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export async function renderSurface(regs: ReadonlyArray<ToolRegistration>): Promise<string> {
  const groups = groupBySource(regs);
  const blocks: string[] = [];

  // Top-level kaizen declaration begins.
  const namespaceLines: string[] = ["declare const kaizen: {"];

  if (groups.local.length > 0) {
    namespaceLines.push("  tools: {");
    namespaceLines.push(await renderToolsDts(sortByName(groups.local).map((r) => r.schema), { indent: "    " }));
    namespaceLines.push("  };");
  }

  const mcpServers = Object.keys(groups.mcp).sort();
  if (mcpServers.length > 0) {
    namespaceLines.push("  mcp: {");
    for (const server of mcpServers) {
      namespaceLines.push(`    ${server}: {`);
      namespaceLines.push(await renderToolsDts(sortByName(groups.mcp[server]!).map((r) => r.schema), { indent: "      " }));
      namespaceLines.push(`    };`);
    }
    namespaceLines.push("  };");
  }

  if (groups.agents.length > 0) {
    namespaceLines.push("  agents: {");
    namespaceLines.push(await renderToolsDts(sortByName(groups.agents).map((r) => r.schema), { indent: "    " }));
    namespaceLines.push("  };");
  }

  if (groups.skills.length > 0) {
    namespaceLines.push("  skills: {");
    namespaceLines.push(await renderToolsDts(sortByName(groups.skills).map((r) => r.schema), { indent: "    " }));
    namespaceLines.push("  };");
  }

  if (groups.memory.length > 0) {
    namespaceLines.push("  memory: {");
    namespaceLines.push(await renderToolsDts(sortByName(groups.memory).map((r) => r.schema), { indent: "    " }));
    namespaceLines.push("  };");
  }

  namespaceLines.push("};");

  blocks.push(PREAMBLE);
  blocks.push("");
  blocks.push("The following API is available:");
  blocks.push("");
  blocks.push("```typescript");
  blocks.push(namespaceLines.join("\n"));
  blocks.push("```");

  return blocks.join("\n");
}
```

- [ ] **Step 4: Adjust `dts-render.ts` to support an `indent` option**

Inspect `plugins/llm-codemode-dispatch/dts-render.ts` and ensure `renderToolsDts(schemas, opts?: { indent?: string })` either exists or is added. If the existing renderer returns the full `declare const kaizen` block, refactor: split into `renderToolsDts(schemas, { indent }): string` (returns just the per-tool method declarations indented) and the existing wrapper for the legacy single-namespace case. If you must change the signature, search for all callers (`grep -rn "renderToolsDts" plugins/llm-codemode-dispatch`) and update them.

The contract for the new shape is: given `[{name, description, parameters}, ...]` and `indent: "    "`, return lines where each method declaration is prefixed by `indent`. Example output (with `indent: "    "`):

```
    /** Read a file. */
    read_file(args: { path: string }): Promise<unknown>;
```

- [ ] **Step 5: Run tests**

Run: `cd plugins/llm-codemode-dispatch && bun test test/assembler.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add plugins/llm-codemode-dispatch/assembler.ts plugins/llm-codemode-dispatch/dts-render.ts plugins/llm-codemode-dispatch/test/assembler.test.ts
git commit -m "feat(llm-codemode-dispatch): grouped-namespace assembler with deterministic hashing"
```

---

## Task 5: Implement `section.ts` — registers `prompt:system` section, listens for tool changes

**Files:**
- Create: `plugins/llm-codemode-dispatch/section.ts`
- Create: `plugins/llm-codemode-dispatch/test/section.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `plugins/llm-codemode-dispatch/test/section.test.ts`:

```typescript
import { describe, expect, it, mock } from "bun:test";
import { makeApiSurfaceSection } from "../section.ts";
import type { ToolRegistration } from "llm-tools-registry/public";

function fakeRegistry(initial: ToolRegistration[] = []) {
  const list = [...initial];
  return {
    listRegistrations: () => [...list],
    push(r: ToolRegistration) { list.push(r); },
    pop(name: string) { const i = list.findIndex((r) => r.schema.name === name); if (i >= 0) list.splice(i, 1); },
  };
}

function reg(name: string, source: ToolRegistration["source"]): ToolRegistration {
  return {
    schema: { name, description: "", parameters: { type: "object", properties: {} } as any },
    handler: async () => null,
    source,
  };
}

describe("makeApiSurfaceSection", () => {
  it("returns a SystemPromptSection with id 'llm-codemode-dispatch:api' at priority 100", () => {
    const r = fakeRegistry();
    const { section } = makeApiSurfaceSection({
      registry: r as any,
      on: (() => () => {}) as any,
    });
    expect(section.id).toBe("llm-codemode-dispatch:api");
    expect(section.priority).toBe(100);
  });

  it("render() emits the assembled surface", async () => {
    const r = fakeRegistry([reg("a", { kind: "local" })]);
    const { section } = makeApiSurfaceSection({ registry: r as any, on: (() => () => {}) as any });
    const out = await section.render();
    expect(out).toContain("kaizen.tools");
  });

  it("subscribes to tools:registered and tools:unregistered to drive bumpGeneration on the host handle", async () => {
    const r = fakeRegistry();
    const subs = new Map<string, (p: unknown) => Promise<void>>();
    const on = mock((event: string, h: any) => { subs.set(event, h); return () => {}; });

    const onChange = mock(() => {});
    const { section, attach } = makeApiSurfaceSection({ registry: r as any, on: on as any });

    attach(onChange);
    expect(on).toHaveBeenCalledWith("tools:registered", expect.any(Function));
    expect(on).toHaveBeenCalledWith("tools:unregistered", expect.any(Function));

    // Simulate a tool registration changing the surface hash.
    r.push(reg("a", { kind: "local" }));
    await subs.get("tools:registered")!({ name: "a", source: { kind: "local" } });
    expect(onChange).toHaveBeenCalled();
    expect(section).toBeTruthy();
  });

  it("does NOT call onChange when the surface hash is unchanged (e.g., re-register with same content)", async () => {
    const r = fakeRegistry([reg("a", { kind: "local" })]);
    const subs = new Map<string, (p: unknown) => Promise<void>>();
    const on = (event: string, h: any) => { subs.set(event, h); return () => {}; };
    const onChange = mock(() => {});

    const { attach } = makeApiSurfaceSection({ registry: r as any, on: on as any });
    attach(onChange);

    // First call (initial subscription) is allowed to bump or not depending on
    // implementation choice; record current call count after attach completes.
    onChange.mockClear();

    // Same registry contents — fire event without an actual change.
    await subs.get("tools:registered")!({ name: "noop", source: { kind: "local" } });
    expect(onChange).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd plugins/llm-codemode-dispatch && bun test test/section.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `section.ts`**

Create `plugins/llm-codemode-dispatch/section.ts`:

```typescript
import type { SystemPromptSection } from "llm-system-prompt/public";
import type { ToolRegistration, ToolsRegistryService } from "llm-tools-registry/public";
import { renderSurface, surfaceHash } from "./assembler.ts";

interface MakeApiSurfaceSectionOpts {
  registry: Pick<ToolsRegistryService, "listRegistrations">;
  on: (event: string, handler: (payload: unknown) => Promise<void> | void) => () => void;
}

export interface ApiSurfaceSectionWiring {
  section: SystemPromptSection;
  /**
   * Wires up `tools:registered` / `tools:unregistered` listeners. The
   * supplied callback is invoked when the surface hash actually changes.
   * Caller is expected to forward this to its prompt:system handle's
   * bumpGeneration().
   */
  attach(onChange: () => void): () => void;
}

export function makeApiSurfaceSection(opts: MakeApiSurfaceSectionOpts): ApiSurfaceSectionWiring {
  const { registry, on } = opts;

  let cachedHash: string = surfaceHash(registry.listRegistrations());
  let cachedRender: string | null = null;

  async function render(): Promise<string> {
    const regs = registry.listRegistrations();
    const h = surfaceHash(regs);
    if (cachedRender !== null && h === cachedHash) return cachedRender;
    cachedHash = h;
    cachedRender = await renderSurface(regs);
    return cachedRender;
  }

  const section: SystemPromptSection = {
    id: "llm-codemode-dispatch:api",
    priority: 100,
    render,
  };

  function attach(onChange: () => void): () => void {
    const handler = async () => {
      const newHash = surfaceHash(registry.listRegistrations());
      if (newHash !== cachedHash) {
        cachedHash = newHash;
        cachedRender = null; // force re-render on next assemble()
        onChange();
      }
    };
    const off1 = on("tools:registered", handler);
    const off2 = on("tools:unregistered", handler);
    return () => { off1(); off2(); };
  }

  return { section, attach };
}
```

- [ ] **Step 4: Run tests**

Run: `cd plugins/llm-codemode-dispatch && bun test test/section.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-codemode-dispatch/section.ts plugins/llm-codemode-dispatch/test/section.test.ts
git commit -m "feat(llm-codemode-dispatch): prompt:system section with hash-gated bump"
```

---

## Task 6: Wire section into `index.ts`; gate `prepareRequest` legacy path

**Files:**
- Modify: `plugins/llm-codemode-dispatch/index.ts`
- Modify: `plugins/llm-codemode-dispatch/prepare-request.ts`

- [ ] **Step 1: Read current index.ts wiring**

Run: `cat plugins/llm-codemode-dispatch/index.ts`
Identify where `tool-dispatch:strategy` is registered and where `prepareRequest` is invoked.

- [ ] **Step 2: Add a setup-time integration test**

Create `plugins/llm-codemode-dispatch/test/index-section-integration.test.ts`:

```typescript
import { describe, expect, it, mock } from "bun:test";
import plugin from "../index.ts";

function makeFakeCtx() {
  const provided: Record<string, unknown> = {};
  const registeredSections: any[] = [];
  const subs = new Map<string, (p: unknown) => unknown>();
  const fakePromptSystem = {
    register: (s: any) => {
      registeredSections.push(s);
      return {
        unregister: () => {},
        bumpGeneration: () => { (registeredSections as any).bumps = ((registeredSections as any).bumps ?? 0) + 1; },
      };
    },
    assemble: async () => "",
    list: () => registeredSections.map((s) => ({ id: s.id, priority: s.priority })),
    generation: () => 0,
  };
  const fakeToolsRegistry = {
    register: () => () => {},
    registerWith: () => () => {},
    list: () => [],
    listRegistrations: () => [],
    invoke: async () => null,
  };
  return {
    cwd: process.cwd(),
    env: {},
    log: () => {},
    defineService: (_n: string, _o: unknown) => {},
    provideService: <T,>(n: string, v: T) => { provided[n] = v; },
    consumeService: () => {},
    useService: (n: string) => {
      if (n === "prompt:system") return fakePromptSystem;
      if (n === "tools:registry") return fakeToolsRegistry;
      return undefined;
    },
    defineEvent: () => {},
    emit: async () => {},
    on: (event: string, h: (p: unknown) => unknown) => {
      subs.set(event, h);
      return () => subs.delete(event);
    },
    config: {},
    provided, registeredSections, subs,
  };
}

describe("index — prompt:system integration", () => {
  it("registers an api section at priority 100 when prompt:system is available", async () => {
    const ctx = makeFakeCtx();
    await plugin.setup!(ctx as any);
    expect(ctx.registeredSections.length).toBe(1);
    expect(ctx.registeredSections[0]!.id).toBe("llm-codemode-dispatch:api");
    expect(ctx.registeredSections[0]!.priority).toBe(100);
  });

  it("when prompt:system is registered, prepareRequest returns no systemPromptAppend", async () => {
    const ctx = makeFakeCtx();
    await plugin.setup!(ctx as any);
    const strategy = ctx.provided["tool-dispatch:strategy"] as any;
    const r = await strategy.prepareRequest({ availableTools: [] });
    expect(r.systemPromptAppend).toBeUndefined();
    expect(r.tools).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd plugins/llm-codemode-dispatch && bun test test/index-section-integration.test.ts`
Expected: FAIL — index.ts does not yet register a section nor gate the legacy path.

- [ ] **Step 4: Modify `index.ts`**

Open `plugins/llm-codemode-dispatch/index.ts`. After the existing service consumption (where `tools:registry` is used), and before `provideService("tool-dispatch:strategy", ...)`, add:

```typescript
import { makeApiSurfaceSection } from "./section.ts";

// ... inside setup(ctx):

let promptSystemSection:
  | { handle: { unregister(): void; bumpGeneration(): void }; detach: () => void }
  | undefined;

const promptSystem = ctx.useService?.("prompt:system") as
  | {
      register(s: any): { unregister(): void; bumpGeneration(): void };
    }
  | undefined;

const toolsRegistry = ctx.useService?.("tools:registry") as
  | {
      listRegistrations(): any[];
    }
  | undefined;

if (promptSystem && toolsRegistry) {
  const wiring = makeApiSurfaceSection({
    registry: toolsRegistry as any,
    on: (event, h) => ctx.on(event, h),
  });
  const handle = promptSystem.register(wiring.section);
  const detach = wiring.attach(() => handle.bumpGeneration());
  promptSystemSection = { handle, detach };
}
```

Then change the strategy provided to `tool-dispatch:strategy`:

```typescript
ctx.provideService("tool-dispatch:strategy", {
  async prepareRequest({ availableTools }) {
    if (promptSystemSection) {
      // System prompt is now contributed via prompt:system; no append needed.
      return {};
    }
    // Legacy fallback: keep emitting systemPromptAppend so harnesses that
    // don't ship llm-system-prompt continue to work.
    return prepareRequest({ availableTools });
  },
  handleResponse,
});
```

- [ ] **Step 5: Run all codemode tests**

Run: `cd plugins/llm-codemode-dispatch && bun test`
Expected: PASS — including the new integration test and pre-existing tests.

- [ ] **Step 6: Commit**

```bash
git add plugins/llm-codemode-dispatch/index.ts plugins/llm-codemode-dispatch/test/index-section-integration.test.ts
git commit -m "feat(llm-codemode-dispatch): register api section via prompt:system; gate legacy systemPromptAppend"
```

---

## Task 7: Sandbox host — expose grouped namespaces

**Files:**
- Modify: `plugins/llm-codemode-dispatch/sandbox-host.ts`
- Create: `plugins/llm-codemode-dispatch/test/sandbox-host-grouped.test.ts`

- [ ] **Step 1: Inspect current sandbox-host**

Run: `grep -n "kaizen\|tools\." plugins/llm-codemode-dispatch/sandbox-host.ts | head -20`
Locate where the `kaizen.tools.<name>` proxy is constructed.

- [ ] **Step 2: Write the failing test**

Create `plugins/llm-codemode-dispatch/test/sandbox-host-grouped.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { buildKaizenGlobal } from "../sandbox-host.ts";
import type { ToolRegistration } from "llm-tools-registry/public";

function reg(name: string, source: ToolRegistration["source"]): ToolRegistration {
  return {
    schema: { name, description: "", parameters: { type: "object", properties: {} } as any },
    handler: async () => null,
    source,
  };
}

describe("buildKaizenGlobal — grouped namespaces", () => {
  it("local tools are reachable via kaizen.tools.<name>", async () => {
    const invoked: string[] = [];
    const invoke = async (name: string) => { invoked.push(name); return "ok"; };
    const k = buildKaizenGlobal({
      registrations: [reg("readFile", { kind: "local" })],
      invoke,
    });
    const out = await (k.tools as any).readFile({});
    expect(out).toBe("ok");
    expect(invoked).toEqual(["readFile"]);
  });

  it("MCP tools are reachable via kaizen.mcp.<server>.<name>", async () => {
    const invoked: string[] = [];
    const invoke = async (name: string) => { invoked.push(name); return "ok"; };
    const k = buildKaizenGlobal({
      registrations: [reg("read_file", { kind: "mcp", server: "filesystem" })],
      invoke,
    });
    const out = await (k.mcp as any).filesystem.read_file({});
    expect(out).toBe("ok");
    expect(invoked).toEqual(["read_file"]);
  });

  it("MCP server name normalization applied: cloudflare-fs → cloudflare_fs", async () => {
    const k = buildKaizenGlobal({
      registrations: [reg("ping", { kind: "mcp", server: "cloudflare-fs" })],
      invoke: async () => "ok",
    });
    expect((k.mcp as any).cloudflare_fs).toBeDefined();
    expect((k.mcp as any)["cloudflare-fs"]).toBeUndefined();
  });

  it("empty namespaces are not exposed (no kaizen.agents when there are no agents)", () => {
    const k = buildKaizenGlobal({
      registrations: [reg("a", { kind: "local" })],
      invoke: async () => null,
    });
    expect((k as any).agents).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd plugins/llm-codemode-dispatch && bun test test/sandbox-host-grouped.test.ts`
Expected: FAIL — `buildKaizenGlobal` is not exported (or doesn't support grouping).

- [ ] **Step 4: Refactor `sandbox-host.ts`**

In `plugins/llm-codemode-dispatch/sandbox-host.ts`, extract a pure helper:

```typescript
import type { ToolRegistration } from "llm-tools-registry/public";
import { normalizeServerName } from "./assembler.ts";

export interface BuildKaizenOpts {
  registrations: ReadonlyArray<ToolRegistration>;
  invoke: (name: string, args: unknown) => Promise<unknown>;
}

export function buildKaizenGlobal(opts: BuildKaizenOpts): Record<string, unknown> {
  const { registrations, invoke } = opts;
  const tools: Record<string, (args: unknown) => Promise<unknown>> = {};
  const mcp: Record<string, Record<string, (args: unknown) => Promise<unknown>>> = {};
  const agents: Record<string, (args: unknown) => Promise<unknown>> = {};
  const skills: Record<string, (args: unknown) => Promise<unknown>> = {};
  const memory: Record<string, (args: unknown) => Promise<unknown>> = {};

  for (const r of registrations) {
    const name = r.schema.name;
    const fn = (args: unknown) => invoke(name, args);
    switch (r.source.kind) {
      case "local": tools[name] = fn; break;
      case "mcp": {
        const server = normalizeServerName(r.source.server);
        if (!mcp[server]) mcp[server] = {};
        mcp[server]![name] = fn;
        break;
      }
      case "agent": agents[name] = fn; break;
      case "skill": skills[name] = fn; break;
      case "memory": memory[name] = fn; break;
    }
  }

  const k: Record<string, unknown> = {};
  if (Object.keys(tools).length > 0) k.tools = tools;
  if (Object.keys(mcp).length > 0) k.mcp = mcp;
  if (Object.keys(agents).length > 0) k.agents = agents;
  if (Object.keys(skills).length > 0) k.skills = skills;
  if (Object.keys(memory).length > 0) k.memory = memory;
  return k;
}
```

Then locate the existing place in `sandbox-host.ts` that builds `globalThis.kaizen` (or the worker-message handler that proxies tool calls) and replace its `kaizen.tools.*` construction with a call to `buildKaizenGlobal({ registrations: registry.listRegistrations(), invoke: ... })`. Pass the same `registry.invoke` wrapper that was previously used (with the existing `ToolExecutionContext` per call).

- [ ] **Step 5: Run all codemode tests**

Run: `cd plugins/llm-codemode-dispatch && bun test`
Expected: PASS — sandbox host tests green, no regressions in pre-existing sandbox tests. If pre-existing tests assumed flat `kaizen.tools.*`, update them to match the grouped shape (they should still cover local-only tools because legacy `register(schema, handler)` defaults source to local).

- [ ] **Step 6: Commit**

```bash
git add plugins/llm-codemode-dispatch/sandbox-host.ts plugins/llm-codemode-dispatch/test/sandbox-host-grouped.test.ts
git commit -m "feat(llm-codemode-dispatch): sandbox exposes grouped kaizen.{tools,mcp,agents,skills,memory}"
```

---

## Task 8: Drop the legacy `prepareRequest` path once the section path is wired

**Files:**
- Modify: `plugins/llm-codemode-dispatch/prepare-request.ts`

This task is intentionally minimal — Task 6 already gates the legacy path on the absence of `prompt:system`. Spec 15 calls for keeping the legacy path "for one minor version" in case some harness ships without `llm-system-prompt`. We document that and leave the file as-is.

- [ ] **Step 1: Add a header comment**

Prepend `plugins/llm-codemode-dispatch/prepare-request.ts` with:

```typescript
// Legacy fallback path for harnesses that ship without llm-system-prompt.
// When prompt:system is provided, index.ts skips this and contributes the
// API surface via the section registry instead. Remove this file once
// llm-system-prompt is universal in the harness manifest.
```

- [ ] **Step 2: Commit**

```bash
git add plugins/llm-codemode-dispatch/prepare-request.ts
git commit -m "docs(llm-codemode-dispatch): mark prepare-request.ts as legacy fallback"
```

---

## Task 9: End-to-end smoke test (manual)

- [ ] **Step 1: Deploy modified plugins**

Run:
```bash
for p in llm-events llm-tools-registry llm-codemode-dispatch; do
  cp -R plugins/$p/. ~/.kaizen/marketplaces/official/plugins/$p@*/
  cd ~/.kaizen/marketplaces/official/plugins/$p@*/ && bun build --target=bun --outfile=dist/index.js index.ts
  cd -
done
```

- [ ] **Step 2: Run the harness with the debug dumper from Plan A's Task 10**

(Re-add the `dumpRequest` helper to `openai-llm/http.ts` if it was removed, or use a logging proxy.)

- [ ] **Step 3: Verify the assembled prompt has grouped namespaces**

Run:
```bash
kaizen --harness official/openai-compatible
# in TUI: send "hi"
# in another shell:
grep -A 30 "declare const kaizen" ~/.kaizen/debug/last-request.txt
```

Expected: the `declare const kaizen` block contains `tools: { ... }` and (if MCP servers are configured) `mcp: { <server>: { ... } }`. No flat `kaizen.read_file()` at the top level.

- [ ] **Step 4: Verify a sandbox call still works**

In the TUI, prompt the model to use a tool. Watch the stream — when it emits a code block, confirm it uses the grouped path (e.g., `await kaizen.tools.bash({ command: "ls" })`) and the tool result comes back. If the model uses the flat form `kaizen.bash(...)` it will fail with "undefined is not a function" — that's expected; the model will recover on its next turn after seeing the error.

- [ ] **Step 5: Verify cache stability**

Send several user messages with no MCP / tool changes in between. Diff `~/.kaizen/debug/request-*.txt`:
```bash
diff <(head -1 -n +200 ~/.kaizen/debug/request-<ts1>.txt) <(head -n +200 ~/.kaizen/debug/request-<ts2>.txt)
```
Expected: only the user-message preview lines differ; the SYSTEM PROMPT block is byte-identical.

- [ ] **Step 6: Smoke commit**

If smoke passes, no commit needed — the tests committed in earlier tasks are the durable artifact.

---

## Self-Review

**Spec coverage:**
- `ToolSource` + `ToolRegistration` (Spec 15 § *Tool source provenance*) → Tasks 1, 2.
- Namespace mapping (Spec 15 § *Namespace mapping*) → Task 4 (assembler), Task 7 (sandbox).
- Server name normalization (Spec 15 § *Server name normalization*) → `normalizeServerName` in Task 4, applied in Tasks 4 and 7.
- Section composition (Spec 15 § *Section composition*) → Task 4.
- Doc-comment rules → covered by existing `dts-render.ts`; verify in Task 4 acceptance.
- Caching + change detection (Spec 15 § *Caching and change detection*) → Task 4 (`surfaceHash`), Task 5 (cached render keyed on hash).
- `tools:registered` / `tools:unregistered` events (Spec 15 § *Spec 0 amendments*) → Tasks 2, 3.
- Migration from `systemPromptAppend` (Spec 15 § *Migration from Spec 5's `systemPromptAppend`*) → Tasks 6, 8.
- Sandbox-side mapping (Spec 15 § *Sandbox-side mapping*) → Task 7.
- Determinism → asserted by `surfaceHash` ordering test in Task 4.
- E2E verification → Task 9.

**Acceptance criteria mapping (from Spec 15):**
1. Local-only → only `kaizen.tools` rendered → Task 4 test.
2. Two MCP servers, no collision → Task 4 test, Task 9 step 3.
3. Add tool → `tools:registered` → `prompt:rebuilt` → driver re-assembles → Task 5 test, Task 9 step 5 inverse (cache stable when nothing changes).
4. Identical input → identical string → Task 5 cache test.
5. Empty namespaces omitted → Tasks 4 + 7 tests.
6. Hyphen normalization → Tasks 4 + 7 tests.
7. Normalization collision → `mcp:registration-conflict` event → DEFERRED to Spec 11 plan; documented as out-of-scope with `groupBySource` reporting conflicts in `groups.conflicts` for the future event source.

**Out of scope (deferred to other plans):**
- Emitting `mcp:registration-conflict` event from `llm-mcp-bridge` when normalized server names collide. The detection lives in `assembler.ts` (`groups.conflicts`); wiring the event is part of Spec 11's plan.
- Token-budget pressure mitigations (just-in-time MCP expansion, per-server opt-out). Deferred to v1 per Spec 15 § *Token-budget pressure*.
