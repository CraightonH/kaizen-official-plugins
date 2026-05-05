# LLM Tools Registry & Native Dispatch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement two Kaizen plugins from Spec 4 — `llm-tools-registry` (the in-memory `(schema, handler)` store and single `tool:*`-emitting execution path) and `llm-native-dispatch` (a `tool-dispatch:strategy` provider that maps OpenAI-style native tool calls onto the registry).

**Architecture:** Registry is the sole execution chokepoint; both native dispatch (this plan) and code-mode dispatch (Spec 5, future) call `registry.invoke()` so `tool:before-execute → tool:execute → tool:result`/`tool:error` fire uniformly. Registry plugin holds an in-memory `Map<string, {schema, handler}>` closed over by the service object. Native dispatch is stateless: `prepareRequest` is a pass-through, `handleResponse` walks `response.toolCalls` sequentially, calls `registry.invoke` per call, serializes results into `tool` messages, and returns `[assistantMessage, ...toolMessages]` (or `[]` when terminal). Both plugins depend only on Spec 0 (`llm-events`) shared types.

**Tech Stack:** TypeScript, Bun runtime, no external runtime deps. Tests use `bun:test`. Spec 0 types are imported from the workspace package `llm-events`.

---

## Prerequisites & Tier-for-Parallelism Map

`llm-events` (Spec 0) and `openai-llm` (Spec 1) already exist on disk; their types are the only cross-plugin contracts this plan consumes. Nothing in this plan touches those plugins.

Tiers indicate which tasks may run in parallel (no shared writes, no read-after-write):

- **Tier R0 (sequential, blocks rest of registry work):** Task R1 (scaffold `llm-tools-registry` package).
- **Tier R1 (parallel after R0, leaf modules):** Task R2 (`registry.ts` core), Task R3 (`CANCEL_TOOL` re-export + `public.d.ts`).
- **Tier R2 (sequential, integrates):** Task R4 (`index.ts` plugin wire-up).
- **Tier N0 (sequential, blocks rest of dispatch work; can run in parallel with Tier R*):** Task N1 (scaffold `llm-native-dispatch` package).
- **Tier N1 (parallel after N0, leaf helpers):** Task N2 (`serialize.ts`), Task N3 (`args-validation.ts`).
- **Tier N2 (sequential, depends on N1):** Task N4 (`strategy.ts` — `prepareRequest` + `handleResponse` loop).
- **Tier N3 (sequential, integrates):** Task N5 (`index.ts` plugin wire-up), Task N6 (`public.d.ts` re-exports).
- **Tier F (sequential, after both plugins built):** Task F1 (cross-plugin integration test), Task F2 (marketplace catalog update).

The two plugins are independent at scaffold/code level — Tier R* and Tier N* can run concurrently. Only Task F1 requires both plugins on disk.

## File Structure

```
plugins/llm-tools-registry/
  index.ts            # KaizenPlugin: setup() defines/provides "tools:registry"
  registry.ts         # makeRegistry(emit): ToolsRegistryService (closure over Map)
  public.d.ts         # re-exports: ToolsRegistryService, ToolSchema, ToolHandler,
                      #   ToolExecutionContext, CANCEL_TOOL
  package.json
  tsconfig.json
  README.md
  test/
    registry.test.ts
    index.test.ts

plugins/llm-native-dispatch/
  index.ts            # KaizenPlugin: setup() defines/provides "tool-dispatch:strategy"
  strategy.ts         # makeStrategy(): ToolDispatchStrategy
  serialize.ts        # serializeResult, serializeError (pure helpers)
  args-validation.ts  # isValidToolArgs, malformedArgsMessage (pure helpers)
  public.d.ts         # re-exports: ToolDispatchStrategy
  package.json
  tsconfig.json
  README.md
  test/
    serialize.test.ts
    args-validation.test.ts
    strategy.test.ts
    index.test.ts
    integration.test.ts        # cross-plugin (uses real registry)
```

Boundaries:
- `registry.ts` is the only stateful module across both plugins.
- `serialize.ts` and `args-validation.ts` are pure, single-purpose, individually unit-testable.
- `strategy.ts` composes the helpers and the registry; no I/O of its own.
- Neither plugin imports the other's runtime code. The integration test in Task F1 imports both packages by path because that is its purpose.

`.kaizen/marketplace.json` is also modified (Task F2).

---

## Task R1: Scaffold `llm-tools-registry` package (Tier R0)

**Files:**
- Create: `plugins/llm-tools-registry/package.json`
- Create: `plugins/llm-tools-registry/tsconfig.json`
- Create: `plugins/llm-tools-registry/index.ts` (placeholder)
- Create: `plugins/llm-tools-registry/public.d.ts` (placeholder)
- Create: `plugins/llm-tools-registry/README.md`

The placeholder files are required so `bun install` and TypeScript can resolve the workspace package; module bodies are filled in by Tasks R2–R4.

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "llm-tools-registry",
  "version": "0.1.0",
  "description": "Central tool registry and single tool-execution chokepoint for the openai-compatible harness.",
  "type": "module",
  "exports": { ".": "./index.ts" },
  "keywords": ["kaizen-plugin"],
  "dependencies": {
    "llm-events": "workspace:*"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "@types/json-schema": "^7.0.15",
    "typescript": "^5.4.0"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true
  }
}
```

- [ ] **Step 3: Write placeholder `index.ts`**

```ts
import type { KaizenPlugin } from "kaizen/types";

const plugin: KaizenPlugin = {
  name: "llm-tools-registry",
  apiVersion: "3.0.0",
  permissions: { tier: "trusted" },
  services: { provides: ["tools:registry"], consumes: ["llm-events:vocabulary"] },
  async setup(ctx) {
    // Filled in by Task R4.
    ctx.defineService("tools:registry", { description: "Central tool registry." });
  },
};

export default plugin;
```

- [ ] **Step 4: Write placeholder `public.d.ts`**

```ts
export type {
  ToolSchema,
  ToolCall,
  ChatMessage,
} from "llm-events/public";

export { CANCEL_TOOL } from "llm-events/public";

// Re-declared here for ergonomic single-import; full bodies live in llm-events.
export type { ToolsRegistryService, ToolHandler, ToolExecutionContext } from "./registry";
```

- [ ] **Step 5: Write `README.md`**

```markdown
# llm-tools-registry

Central tool registry for the openai-compatible harness. Provides the
`tools:registry` service: any plugin may `register(schema, handler)` and any
consumer (driver, dispatch strategy, agent) may `list()` / `invoke()`. The
registry is the single place that emits `tool:before-execute`, `tool:execute`,
`tool:result`, and `tool:error` so observability is uniform regardless of
which dispatch strategy is active. In-memory only; plugins re-register on
every `setup`.
```

- [ ] **Step 6: Refresh workspace install**

Run: `bun install`
Expected: workspace resolves `llm-tools-registry`; no errors.

- [ ] **Step 7: Sanity smoke**

Run: `bun -e "import('./plugins/llm-tools-registry/index.ts').then(m => console.log(m.default.name))"`
Expected: `llm-tools-registry`.

- [ ] **Step 8: Commit**

```bash
git add plugins/llm-tools-registry/
git commit -m "feat(llm-tools-registry): scaffold plugin package (skeleton only)"
```

---

## Task R2: `registry.ts` — registry core (Tier R1)

**Files:**
- Create: `plugins/llm-tools-registry/registry.ts`
- Create: `plugins/llm-tools-registry/test/registry.test.ts`

Implements `makeRegistry(emit)` which returns a `ToolsRegistryService` closed over a private `Map<string, Entry>`. The map is keyed by tool name; each entry holds `{ schema, handler }`. The `unregister` closure remembers the entry by reference so it never removes a same-named replacement.

Behavior contract (Spec 4):
- `register`: validates `schema.name` non-empty, throws on duplicate name, stores entry, returns reference-identity `unregister` closure (idempotent).
- `list(filter?)`: snapshot (cloned array). `filter.tags` (any-match), `filter.names` (set-membership), AND-combined. Insertion order.
- `invoke(name, args, ctx)`:
  1. Unknown name → emit `tool:error` (with `name`, `callId`, `message`); reject. Do NOT emit `tool:before-execute`.
  2. Emit `tool:before-execute` with mutable payload `{ name, args, callId }`. Await all subscribers.
  3. If `payload.args === CANCEL_TOOL` (i.e. `Symbol.for("kaizen.cancel")`) → emit `tool:error` with `message: "cancelled by subscriber"`, reject with the same error. Do NOT emit `tool:execute` or `tool:result`.
  4. Emit `tool:execute` with the (possibly-mutated) `{ name, args, callId }`.
  5. Await `handler(args, ctx)`. On success → emit `tool:result` with `{ name, callId, result }`, resolve with `result`. On throw → emit `tool:error` with `{ name, callId, message, cause }`, re-reject with original error.
- The registry does NOT race the handler against `ctx.signal`; handlers are responsible for their own cancellation.
- Concurrent invocations are independent; each call sees its own payload object.

The `emit` parameter is the function the plugin receives from `ctx.emit`. Decoupling it lets the unit test assert event sequences directly.

- [ ] **Step 1: Write the failing tests**

Create `plugins/llm-tools-registry/test/registry.test.ts`:

```ts
import { describe, it, expect, mock } from "bun:test";
import { makeRegistry } from "../registry.ts";
import { CANCEL_TOOL } from "llm-events/public";
import type { ToolSchema } from "llm-events/public";

const SCHEMA = (name: string, tags?: string[]): ToolSchema => ({
  name,
  description: `${name} desc`,
  parameters: { type: "object", properties: {}, additionalProperties: false } as any,
  tags,
});

function captureEmit() {
  const events: { name: string; payload: any }[] = [];
  const subscribers: Record<string, ((p: any) => Promise<void> | void)[]> = {};
  const emit = mock(async (name: string, payload: unknown) => {
    events.push({ name, payload });
    for (const fn of subscribers[name] ?? []) await fn(payload);
  });
  function on(name: string, fn: (p: any) => Promise<void> | void) {
    (subscribers[name] ??= []).push(fn);
  }
  return { emit, on, events };
}

const ctx = (callId = "c1") => ({
  signal: new AbortController().signal,
  callId,
  log: () => {},
});

describe("makeRegistry — register/list/unregister", () => {
  it("register then list returns the schema", () => {
    const { emit } = captureEmit();
    const r = makeRegistry(emit as any);
    r.register(SCHEMA("a"), async () => "ok");
    expect(r.list().map((s) => s.name)).toEqual(["a"]);
  });

  it("unregister removes the entry", () => {
    const { emit } = captureEmit();
    const r = makeRegistry(emit as any);
    const off = r.register(SCHEMA("a"), async () => "ok");
    off();
    expect(r.list()).toEqual([]);
  });

  it("duplicate register throws", () => {
    const { emit } = captureEmit();
    const r = makeRegistry(emit as any);
    r.register(SCHEMA("a"), async () => "ok");
    expect(() => r.register(SCHEMA("a"), async () => "ok")).toThrow(/already registered/);
  });

  it("empty name rejected", () => {
    const { emit } = captureEmit();
    const r = makeRegistry(emit as any);
    expect(() => r.register(SCHEMA(""), async () => "ok")).toThrow(/name/);
  });

  it("unregister is idempotent", () => {
    const { emit } = captureEmit();
    const r = makeRegistry(emit as any);
    const off = r.register(SCHEMA("a"), async () => "ok");
    off();
    off(); // second call: no throw
    expect(r.list()).toEqual([]);
  });

  it("unregister does not remove a same-named replacement", () => {
    const { emit } = captureEmit();
    const r = makeRegistry(emit as any);
    const off1 = r.register(SCHEMA("a"), async () => "v1");
    off1();
    r.register(SCHEMA("a"), async () => "v2");
    off1(); // identifies entry by reference
    expect(r.list().map((s) => s.name)).toEqual(["a"]);
  });

  it("list({ tags }) any-match", () => {
    const { emit } = captureEmit();
    const r = makeRegistry(emit as any);
    r.register(SCHEMA("a", ["fs"]), async () => "");
    r.register(SCHEMA("b", ["net"]), async () => "");
    r.register(SCHEMA("c", ["fs", "net"]), async () => "");
    expect(r.list({ tags: ["fs"] }).map((s) => s.name)).toEqual(["a", "c"]);
  });

  it("list({ names })", () => {
    const { emit } = captureEmit();
    const r = makeRegistry(emit as any);
    r.register(SCHEMA("a"), async () => "");
    r.register(SCHEMA("b"), async () => "");
    expect(r.list({ names: ["b"] }).map((s) => s.name)).toEqual(["b"]);
  });

  it("list({ tags, names }) AND-combined", () => {
    const { emit } = captureEmit();
    const r = makeRegistry(emit as any);
    r.register(SCHEMA("a", ["fs"]), async () => "");
    r.register(SCHEMA("b", ["fs"]), async () => "");
    r.register(SCHEMA("c", ["net"]), async () => "");
    expect(r.list({ tags: ["fs"], names: ["b", "c"] }).map((s) => s.name)).toEqual(["b"]);
  });

  it("list returns a clone (mutating result does not mutate registry)", () => {
    const { emit } = captureEmit();
    const r = makeRegistry(emit as any);
    r.register(SCHEMA("a"), async () => "");
    const out = r.list();
    out.length = 0;
    expect(r.list().length).toBe(1);
  });
});

describe("makeRegistry — invoke", () => {
  it("unknown tool emits tool:error and rejects", async () => {
    const { emit, events } = captureEmit();
    const r = makeRegistry(emit as any);
    await expect(r.invoke("nope", {}, ctx())).rejects.toThrow(/unknown tool/);
    expect(events.map((e) => e.name)).toEqual(["tool:error"]);
    expect(events[0].payload).toMatchObject({ name: "nope", callId: "c1", message: expect.stringMatching(/unknown tool/) });
  });

  it("happy path emits before-execute, execute, result in order", async () => {
    const { emit, events } = captureEmit();
    const r = makeRegistry(emit as any);
    r.register(SCHEMA("a"), async (args) => ({ echoed: args }));
    const result = await r.invoke("a", { x: 1 }, ctx());
    expect(result).toEqual({ echoed: { x: 1 } });
    expect(events.map((e) => e.name)).toEqual(["tool:before-execute", "tool:execute", "tool:result"]);
    expect(events[0].payload).toMatchObject({ name: "a", args: { x: 1 }, callId: "c1" });
    expect(events[2].payload).toMatchObject({ name: "a", callId: "c1", result: { echoed: { x: 1 } } });
  });

  it("subscriber that mutates args is observed by handler and tool:execute", async () => {
    const { emit, on, events } = captureEmit();
    const r = makeRegistry(emit as any);
    on("tool:before-execute", (p) => { p.args = { rewritten: true }; });
    let seenByHandler: unknown = null;
    r.register(SCHEMA("a"), async (args) => { seenByHandler = args; return "ok"; });
    await r.invoke("a", { original: true }, ctx());
    expect(seenByHandler).toEqual({ rewritten: true });
    const exec = events.find((e) => e.name === "tool:execute")!;
    expect(exec.payload).toMatchObject({ args: { rewritten: true } });
  });

  it("subscriber that sets args = CANCEL_TOOL short-circuits", async () => {
    const { emit, on, events } = captureEmit();
    const r = makeRegistry(emit as any);
    on("tool:before-execute", (p) => { p.args = CANCEL_TOOL; });
    let handlerCalled = false;
    r.register(SCHEMA("a"), async () => { handlerCalled = true; return "ok"; });
    await expect(r.invoke("a", {}, ctx())).rejects.toThrow(/cancelled/);
    expect(handlerCalled).toBe(false);
    expect(events.map((e) => e.name)).toEqual(["tool:before-execute", "tool:error"]);
  });

  it("handler throw emits tool:error and re-rejects with original error", async () => {
    const { emit, events } = captureEmit();
    const r = makeRegistry(emit as any);
    const boom = new Error("boom");
    r.register(SCHEMA("a"), async () => { throw boom; });
    await expect(r.invoke("a", {}, ctx())).rejects.toBe(boom);
    expect(events.map((e) => e.name)).toEqual(["tool:before-execute", "tool:execute", "tool:error"]);
    expect(events[2].payload).toMatchObject({ name: "a", callId: "c1", message: "boom", cause: boom });
  });

  it("two concurrent invokes have independent event streams", async () => {
    const { emit, events } = captureEmit();
    const r = makeRegistry(emit as any);
    let resolveA: (v: string) => void = () => {};
    let resolveB: (v: string) => void = () => {};
    r.register(SCHEMA("a"), () => new Promise<string>((res) => { resolveA = res; }));
    r.register(SCHEMA("b"), () => new Promise<string>((res) => { resolveB = res; }));
    const pa = r.invoke("a", {}, ctx("ca"));
    const pb = r.invoke("b", {}, ctx("cb"));
    resolveB("rb");
    resolveA("ra");
    await Promise.all([pa, pb]);
    const ca = events.filter((e) => (e.payload as any).callId === "ca").map((e) => e.name);
    const cb = events.filter((e) => (e.payload as any).callId === "cb").map((e) => e.name);
    expect(ca).toEqual(["tool:before-execute", "tool:execute", "tool:result"]);
    expect(cb).toEqual(["tool:before-execute", "tool:execute", "tool:result"]);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `bun test plugins/llm-tools-registry/test/registry.test.ts`
Expected: FAIL — `../registry.ts` not found.

- [ ] **Step 3: Implement `registry.ts`**

```ts
import type {
  ToolSchema,
  ToolCall,
} from "llm-events/public";
import { CANCEL_TOOL } from "llm-events/public";

export interface ToolExecutionContext {
  signal: AbortSignal;
  callId: string;
  turnId?: string;
  log: (msg: string) => void;
}

export type ToolHandler = (args: unknown, ctx: ToolExecutionContext) => Promise<unknown>;

export interface ToolsRegistryService {
  register(schema: ToolSchema, handler: ToolHandler): () => void;
  list(filter?: { tags?: string[]; names?: string[] }): ToolSchema[];
  invoke(name: string, args: unknown, ctx: ToolExecutionContext): Promise<unknown>;
}

interface Entry { schema: ToolSchema; handler: ToolHandler; }

type Emit = (event: string, payload: unknown) => Promise<unknown[]>;

export function makeRegistry(emit: Emit): ToolsRegistryService {
  const entries = new Map<string, Entry>();

  function register(schema: ToolSchema, handler: ToolHandler): () => void {
    if (typeof schema.name !== "string" || schema.name.length === 0) {
      throw new Error("ToolSchema.name must be a non-empty string");
    }
    if (entries.has(schema.name)) {
      throw new Error(`tool already registered: ${schema.name}`);
    }
    const entry: Entry = { schema, handler };
    entries.set(schema.name, entry);
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      // Reference identity: only remove if this exact entry is still mapped.
      const cur = entries.get(schema.name);
      if (cur === entry) entries.delete(schema.name);
    };
  }

  function list(filter?: { tags?: string[]; names?: string[] }): ToolSchema[] {
    const out: ToolSchema[] = [];
    const tagSet = filter?.tags ? new Set(filter.tags) : null;
    const nameSet = filter?.names ? new Set(filter.names) : null;
    for (const { schema } of entries.values()) {
      if (nameSet && !nameSet.has(schema.name)) continue;
      if (tagSet) {
        const tags = schema.tags ?? [];
        let any = false;
        for (const t of tags) if (tagSet.has(t)) { any = true; break; }
        if (!any) continue;
      }
      out.push(schema);
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

  return { register, list, invoke };
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `bun test plugins/llm-tools-registry/test/registry.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-tools-registry/registry.ts plugins/llm-tools-registry/test/registry.test.ts
git commit -m "feat(llm-tools-registry): registry core with tool:* event emission"
```

---

## Task R3: `public.d.ts` re-exports finalized (Tier R1)

**Files:**
- Modify: `plugins/llm-tools-registry/public.d.ts`

The placeholder from Task R1 is already correct shape; this task locks it in and runs a no-shape-drift acceptance check (matches the rule from Spec 0 acceptance criteria: consumers import the contracts from the owning plugin).

- [ ] **Step 1: Replace `public.d.ts` with the final form**

```ts
// llm-tools-registry public surface — re-exports only.
// Spec 0 owns ToolSchema, ToolCall, ChatMessage, CANCEL_TOOL.
// This plugin owns ToolsRegistryService, ToolHandler, ToolExecutionContext.

export type {
  ToolSchema,
  ToolCall,
  ChatMessage,
} from "llm-events/public";

export { CANCEL_TOOL } from "llm-events/public";

export type {
  ToolsRegistryService,
  ToolHandler,
  ToolExecutionContext,
} from "./registry";
```

- [ ] **Step 2: Acceptance grep — no Spec 0 type re-declared**

Run: `grep -nE "interface (ToolSchema|ToolCall|ChatMessage)" plugins/llm-tools-registry/`
Expected: NO matches (Spec 0 owns these; this plugin only re-exports).

- [ ] **Step 3: Type-check the package**

Run: `bun --bun tsc --noEmit -p plugins/llm-tools-registry/tsconfig.json plugins/llm-tools-registry/index.ts plugins/llm-tools-registry/registry.ts plugins/llm-tools-registry/public.d.ts`
Expected: no diagnostics.

- [ ] **Step 4: Commit (if file changed)**

```bash
git add plugins/llm-tools-registry/public.d.ts
git commit -m "chore(llm-tools-registry): finalize public.d.ts re-exports" || echo "no changes"
```

---

## Task R4: `index.ts` — wire setup, define and provide service (Tier R2)

**Files:**
- Modify: `plugins/llm-tools-registry/index.ts`
- Create: `plugins/llm-tools-registry/test/index.test.ts`

The plugin's `setup` builds an `emit` adapter from `ctx.emit`, calls `makeRegistry(emit)`, defines the `tools:registry` service, and provides the registry instance.

- [ ] **Step 1: Write the failing test**

Create `plugins/llm-tools-registry/test/index.test.ts`:

```ts
import { describe, it, expect, mock } from "bun:test";
import plugin from "../index.ts";
import type { ToolsRegistryService } from "../registry.ts";

function makeCtx() {
  const provided: Record<string, unknown> = {};
  return {
    provided,
    log: mock(() => {}),
    config: {},
    defineEvent: mock(() => {}),
    on: mock(() => {}),
    emit: mock(async () => []),
    defineService: mock(() => {}),
    provideService: mock((name: string, impl: unknown) => { provided[name] = impl; }),
    consumeService: mock(() => {}),
    useService: mock(() => undefined),
    secrets: { get: mock(async () => undefined), refresh: mock(async () => undefined) },
  } as any;
}

describe("llm-tools-registry plugin", () => {
  it("metadata", () => {
    expect(plugin.name).toBe("llm-tools-registry");
    expect(plugin.apiVersion).toBe("3.0.0");
    expect(plugin.permissions).toEqual({ tier: "trusted" });
    expect(plugin.services?.provides).toContain("tools:registry");
    expect(plugin.services?.consumes).toContain("llm-events:vocabulary");
  });

  it("setup defines and provides tools:registry with the registry instance", async () => {
    const ctx = makeCtx();
    await plugin.setup(ctx);
    expect(ctx.defineService).toHaveBeenCalledWith("tools:registry", expect.objectContaining({ description: expect.any(String) }));
    const svc = ctx.provided["tools:registry"] as ToolsRegistryService;
    expect(svc).toBeDefined();
    expect(typeof svc.register).toBe("function");
    expect(typeof svc.list).toBe("function");
    expect(typeof svc.invoke).toBe("function");
  });

  it("invoking a registered tool routes events through ctx.emit", async () => {
    const ctx = makeCtx();
    await plugin.setup(ctx);
    const svc = ctx.provided["tools:registry"] as ToolsRegistryService;
    svc.register(
      { name: "noop", description: "", parameters: { type: "object" } as any },
      async () => "done",
    );
    await svc.invoke("noop", {}, { signal: new AbortController().signal, callId: "c1", log: () => {} });
    const names = (ctx.emit as any).mock.calls.map((c: any[]) => c[0]);
    expect(names).toEqual(["tool:before-execute", "tool:execute", "tool:result"]);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `bun test plugins/llm-tools-registry/test/index.test.ts`
Expected: FAIL — placeholder index does not provide a registry instance.

- [ ] **Step 3: Replace placeholder `index.ts`**

```ts
import type { KaizenPlugin } from "kaizen/types";
import { makeRegistry } from "./registry.ts";
import type { ToolsRegistryService } from "./registry.ts";

const plugin: KaizenPlugin = {
  name: "llm-tools-registry",
  apiVersion: "3.0.0",
  permissions: { tier: "trusted" },
  services: { provides: ["tools:registry"], consumes: ["llm-events:vocabulary"] },

  async setup(ctx) {
    const emit = (event: string, payload: unknown) => ctx.emit(event, payload);
    const registry = makeRegistry(emit);
    ctx.defineService("tools:registry", {
      description: "Central tool registry (single tool-execution chokepoint).",
    });
    ctx.provideService<ToolsRegistryService>("tools:registry", registry);
  },
};

export default plugin;
```

- [ ] **Step 4: Run, expect PASS**

Run: `bun test plugins/llm-tools-registry/`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-tools-registry/index.ts plugins/llm-tools-registry/test/index.test.ts
git commit -m "feat(llm-tools-registry): wire setup() to provide tools:registry"
```

---

## Task N1: Scaffold `llm-native-dispatch` package (Tier N0)

**Files:**
- Create: `plugins/llm-native-dispatch/package.json`
- Create: `plugins/llm-native-dispatch/tsconfig.json`
- Create: `plugins/llm-native-dispatch/index.ts` (placeholder)
- Create: `plugins/llm-native-dispatch/public.d.ts` (placeholder)
- Create: `plugins/llm-native-dispatch/README.md`

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "llm-native-dispatch",
  "version": "0.1.0",
  "description": "Native OpenAI tool-calling dispatch strategy for the openai-compatible harness.",
  "type": "module",
  "exports": { ".": "./index.ts" },
  "keywords": ["kaizen-plugin"],
  "dependencies": {
    "llm-events": "workspace:*",
    "llm-tools-registry": "workspace:*"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "@types/json-schema": "^7.0.15",
    "typescript": "^5.4.0"
  }
}
```

Note: the `llm-tools-registry` workspace dep is for *types only* (`ToolsRegistryService` is reachable via `llm-events` shared types per Spec 0, but importing the type from `llm-tools-registry/public` is the more ergonomic single-import). At runtime no symbol is imported.

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true
  }
}
```

- [ ] **Step 3: Write placeholder `index.ts`**

```ts
import type { KaizenPlugin } from "kaizen/types";

const plugin: KaizenPlugin = {
  name: "llm-native-dispatch",
  apiVersion: "3.0.0",
  permissions: { tier: "trusted" },
  services: {
    provides: ["tool-dispatch:strategy"],
    consumes: ["tools:registry", "llm-events:vocabulary"],
  },
  async setup(ctx) {
    // Filled in by Task N5.
    ctx.defineService("tool-dispatch:strategy", { description: "Native OpenAI tool-calling dispatch strategy." });
  },
};

export default plugin;
```

- [ ] **Step 4: Write placeholder `public.d.ts`**

```ts
export type { ToolDispatchStrategy } from "./strategy";
```

- [ ] **Step 5: Write `README.md`**

```markdown
# llm-native-dispatch

Native OpenAI tool-calling dispatch strategy. Provides the
`tool-dispatch:strategy` service: `prepareRequest` passes registered tool
schemas straight through to the LLM request; `handleResponse` walks any
`response.toolCalls` sequentially, executes each via `registry.invoke`, and
returns `[assistantMessage, ...toolMessages]` so the driver's loop can
continue. Errors become tool messages, never thrown exceptions, so a single
bad tool call does not kill the conversation.
```

- [ ] **Step 6: Refresh workspace install**

Run: `bun install`
Expected: workspace resolves all three packages.

- [ ] **Step 7: Sanity smoke**

Run: `bun -e "import('./plugins/llm-native-dispatch/index.ts').then(m => console.log(m.default.name))"`
Expected: `llm-native-dispatch`.

- [ ] **Step 8: Commit**

```bash
git add plugins/llm-native-dispatch/
git commit -m "feat(llm-native-dispatch): scaffold plugin package (skeleton only)"
```

---

## Task N2: `serialize.ts` — result/error serialization helpers (Tier N1)

**Files:**
- Create: `plugins/llm-native-dispatch/serialize.ts`
- Create: `plugins/llm-native-dispatch/test/serialize.test.ts`

Pure helpers. `serializeResult(value)` returns a string per Spec 4 §"Result serialization":
- string → as-is
- `undefined`/`null` → `""`
- otherwise `JSON.stringify(value)`; if that throws (circular ref) → `String(value)` and report a `circular: true` flag so the caller can emit `tool:error`.

`serializeError(message)` returns `JSON.stringify({ error: message })`.

- [ ] **Step 1: Write the failing test**

```ts
// plugins/llm-native-dispatch/test/serialize.test.ts
import { describe, it, expect } from "bun:test";
import { serializeResult, serializeError } from "../serialize.ts";

describe("serializeResult", () => {
  it("string passes through", () => {
    expect(serializeResult("hi")).toEqual({ content: "hi", circular: false });
  });
  it("undefined → empty string", () => {
    expect(serializeResult(undefined)).toEqual({ content: "", circular: false });
  });
  it("null → empty string", () => {
    expect(serializeResult(null)).toEqual({ content: "", circular: false });
  });
  it("number → JSON-stringified", () => {
    expect(serializeResult(42)).toEqual({ content: "42", circular: false });
  });
  it("object → JSON-stringified", () => {
    expect(serializeResult({ a: 1 })).toEqual({ content: '{"a":1}', circular: false });
  });
  it("array → JSON-stringified", () => {
    expect(serializeResult([1, 2])).toEqual({ content: "[1,2]", circular: false });
  });
  it("circular structure → String() fallback with circular: true", () => {
    const o: any = { a: 1 };
    o.self = o;
    const out = serializeResult(o);
    expect(out.circular).toBe(true);
    expect(out.content).toBe(String(o));
  });
});

describe("serializeError", () => {
  it("wraps message in { error }", () => {
    expect(serializeError("boom")).toBe('{"error":"boom"}');
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**

Run: `bun test plugins/llm-native-dispatch/test/serialize.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `serialize.ts`**

```ts
export interface SerializeResult {
  content: string;
  circular: boolean;
}

export function serializeResult(value: unknown): SerializeResult {
  if (typeof value === "string") return { content: value, circular: false };
  if (value === undefined || value === null) return { content: "", circular: false };
  try {
    return { content: JSON.stringify(value), circular: false };
  } catch {
    return { content: String(value), circular: true };
  }
}

export function serializeError(message: string): string {
  return JSON.stringify({ error: message });
}
```

- [ ] **Step 4: Run, expect PASS.**

Run: `bun test plugins/llm-native-dispatch/test/serialize.test.ts`

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-native-dispatch/serialize.ts plugins/llm-native-dispatch/test/serialize.test.ts
git commit -m "feat(llm-native-dispatch): result/error serialization helpers"
```

---

## Task N3: `args-validation.ts` — malformed-args detection (Tier N1)

**Files:**
- Create: `plugins/llm-native-dispatch/args-validation.ts`
- Create: `plugins/llm-native-dispatch/test/args-validation.test.ts`

Spec 4 §"Malformed `arguments` from the LLM": `ToolCall.arguments` is supposed to be already JSON-parsed (a plain object, array, or primitive). If it is anything else — a string body that did not parse, an `Error` instance, a function — treat as malformed and synthesize an error tool message instead of invoking the registry.

`isValidToolArgs(value)` returns `true` for plain objects, arrays, strings (allowed as a simple primitive), numbers, booleans, and `null`/`undefined`. Returns `false` for `Error` instances, functions, symbols, and (notably) class instances that are not plain objects/arrays.

Wait — Spec 4 says the *defensive case* is when `arguments` is "a string (the unparsed body) or an Error sentinel". A primitive string IS valid JSON in some parses, but Spec 4 explicitly calls out that a string-typed `arguments` here is the malformed case. So we MUST treat a string-typed `arguments` as malformed (because the contract says `ToolCall.arguments` is already parsed; a string here means parse failed and the unparsed body was forwarded).

Refined rule: valid iff `typeof value === "object"` (including arrays and `null`) AND value is not an `Error` instance. Strings, numbers, booleans, functions, symbols, undefined → invalid.

Spec 0 declares `arguments: unknown` so we have leeway. The strict rule above matches Spec 4's stated intent.

- [ ] **Step 1: Write the failing test**

```ts
// plugins/llm-native-dispatch/test/args-validation.test.ts
import { describe, it, expect } from "bun:test";
import { isValidToolArgs, malformedArgsMessage } from "../args-validation.ts";

describe("isValidToolArgs", () => {
  it("plain object → true", () => {
    expect(isValidToolArgs({ x: 1 })).toBe(true);
  });
  it("array → true", () => {
    expect(isValidToolArgs([1, 2])).toBe(true);
  });
  it("null → true", () => {
    expect(isValidToolArgs(null)).toBe(true);
  });
  it("string (unparsed body) → false", () => {
    expect(isValidToolArgs('{"x":1}')).toBe(false);
  });
  it("number → false", () => {
    expect(isValidToolArgs(42)).toBe(false);
  });
  it("boolean → false", () => {
    expect(isValidToolArgs(true)).toBe(false);
  });
  it("undefined → false", () => {
    expect(isValidToolArgs(undefined)).toBe(false);
  });
  it("Error instance → false", () => {
    expect(isValidToolArgs(new Error("parse failed"))).toBe(false);
  });
  it("function → false", () => {
    expect(isValidToolArgs(() => {})).toBe(false);
  });
});

describe("malformedArgsMessage", () => {
  it("includes raw stringified value", () => {
    const out = malformedArgsMessage("{not json");
    expect(JSON.parse(out)).toEqual({ error: "malformed arguments JSON from LLM", raw: "{not json" });
  });
  it("stringifies non-string raw values", () => {
    const out = malformedArgsMessage(42);
    expect(JSON.parse(out)).toEqual({ error: "malformed arguments JSON from LLM", raw: "42" });
  });
  it("Error instance raw → message", () => {
    const out = malformedArgsMessage(new Error("boom"));
    expect(JSON.parse(out).raw).toMatch(/boom/);
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement `args-validation.ts`**

```ts
export function isValidToolArgs(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== "object") return false;
  if (value instanceof Error) return false;
  return true;
}

export function malformedArgsMessage(raw: unknown): string {
  let rawStr: string;
  if (typeof raw === "string") rawStr = raw;
  else if (raw instanceof Error) rawStr = String(raw.message);
  else {
    try { rawStr = JSON.stringify(raw); } catch { rawStr = String(raw); }
  }
  return JSON.stringify({ error: "malformed arguments JSON from LLM", raw: rawStr });
}
```

- [ ] **Step 4: Run, expect PASS.**

Run: `bun test plugins/llm-native-dispatch/test/args-validation.test.ts`

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-native-dispatch/args-validation.ts plugins/llm-native-dispatch/test/args-validation.test.ts
git commit -m "feat(llm-native-dispatch): defensive args-validation helpers"
```

---

## Task N4: `strategy.ts` — `prepareRequest` + `handleResponse` (Tier N2)

**Files:**
- Create: `plugins/llm-native-dispatch/strategy.ts`
- Create: `plugins/llm-native-dispatch/test/strategy.test.ts`

Implements `makeStrategy(): ToolDispatchStrategy`. Behavior contract from Spec 4:

- `prepareRequest({ availableTools })` → `{ tools: availableTools }`. Pass-through. If `availableTools` is empty, returns `{ tools: [] }`. Never sets `systemPromptAppend`.
- `handleResponse({ response, registry, signal, emit })`:
  - **Case A — terminal:** if `response.toolCalls` is `undefined` or empty → return `[]`.
  - **Case B — tool calls:**
    - Build `assistantMessage` first: `{ role: "assistant", content: response.content ?? "", toolCalls: response.toolCalls }`.
    - For each `toolCall` in `response.toolCalls` (in order):
      - If `signal.aborted` already at top of loop iteration, fill in a "cancelled" tool message for this call AND every remaining call, then break.
      - If `!isValidToolArgs(toolCall.arguments)`:
        - Emit `tool:error` with `{ name: toolCall.name, callId: toolCall.id, message: "malformed arguments JSON from LLM" }`.
        - Push tool message with `content = malformedArgsMessage(toolCall.arguments)`.
        - Continue.
      - Build `ctx = { signal, callId: toolCall.id, log: (msg) => emit("status:item-update", { key: \`tool:${toolCall.id}\`, value: msg }) }`.
      - `try { result = await registry.invoke(toolCall.name, toolCall.arguments, ctx); content = serializeResult(result); if (content.circular) emit("tool:error", { name: toolCall.name, callId: toolCall.id, message: "result not JSON-serializable, coerced to string" }); } catch (err) { content = serializeError(err.message); }`
      - Push tool message: `{ role: "tool", toolCallId: toolCall.id, name: toolCall.name, content: content.content (or serialized error string) }`.
    - Return `[assistantMessage, ...toolMessages]`.

Note on the cancellation path: when `signal.aborted` is observed mid-loop, the spec requires "any not-yet-invoked calls" to receive a "cancelled" tool message so the conversation stays well-formed. We DO NOT call `registry.invoke` after abort.

- [ ] **Step 1: Write the failing tests**

```ts
// plugins/llm-native-dispatch/test/strategy.test.ts
import { describe, it, expect, mock } from "bun:test";
import { makeStrategy } from "../strategy.ts";
import type { ToolsRegistryService } from "llm-tools-registry/public";
import type { ToolCall, LLMResponse, ToolSchema } from "llm-events/public";

function fakeRegistry(handlers: Record<string, (args: unknown) => Promise<unknown> | unknown>): ToolsRegistryService {
  const list: ToolSchema[] = [];
  return {
    register: () => () => {},
    list: () => list,
    invoke: async (name: string, args: unknown) => {
      const h = handlers[name];
      if (!h) throw new Error(`unknown tool: ${name}`);
      return await h(args);
    },
  };
}

const SCHEMA = (n: string): ToolSchema => ({ name: n, description: "", parameters: { type: "object" } as any });

function tc(id: string, name: string, args: unknown): ToolCall { return { id, name, arguments: args }; }
const noEmit = mock(async () => {});

describe("prepareRequest", () => {
  it("passes through available tools", () => {
    const s = makeStrategy();
    const out = s.prepareRequest({ availableTools: [SCHEMA("a"), SCHEMA("b")] });
    expect(out.tools?.map((t) => t.name)).toEqual(["a", "b"]);
    expect(out.systemPromptAppend).toBeUndefined();
  });

  it("empty tools → empty tools", () => {
    const s = makeStrategy();
    expect(s.prepareRequest({ availableTools: [] })).toEqual({ tools: [] });
  });
});

describe("handleResponse — terminal", () => {
  it("no toolCalls → []", async () => {
    const s = makeStrategy();
    const r: LLMResponse = { content: "done", finishReason: "stop" };
    const out = await s.handleResponse({
      response: r,
      registry: fakeRegistry({}),
      signal: new AbortController().signal,
      emit: noEmit,
    });
    expect(out).toEqual([]);
  });

  it("empty toolCalls array → []", async () => {
    const s = makeStrategy();
    const r: LLMResponse = { content: "done", toolCalls: [], finishReason: "stop" };
    const out = await s.handleResponse({
      response: r,
      registry: fakeRegistry({}),
      signal: new AbortController().signal,
      emit: noEmit,
    });
    expect(out).toEqual([]);
  });
});

describe("handleResponse — tool calls", () => {
  it("one tool call → [assistant, tool] with serialized result", async () => {
    const s = makeStrategy();
    const r: LLMResponse = {
      content: "",
      toolCalls: [tc("c1", "echo", { x: 1 })],
      finishReason: "tool_calls",
    };
    const out = await s.handleResponse({
      response: r,
      registry: fakeRegistry({ echo: (a) => ({ got: a }) }),
      signal: new AbortController().signal,
      emit: noEmit,
    });
    expect(out.length).toBe(2);
    expect(out[0]).toMatchObject({ role: "assistant", toolCalls: r.toolCalls });
    expect(out[1]).toMatchObject({
      role: "tool",
      toolCallId: "c1",
      name: "echo",
      content: '{"got":{"x":1}}',
    });
  });

  it("three tool calls → [assistant, t1, t2, t3] in order, sequential", async () => {
    const s = makeStrategy();
    const order: string[] = [];
    const reg = fakeRegistry({
      a: async () => { order.push("a"); return "ra"; },
      b: async () => { order.push("b"); return "rb"; },
      c: async () => { order.push("c"); return "rc"; },
    });
    const r: LLMResponse = {
      content: "",
      toolCalls: [tc("1", "a", {}), tc("2", "b", {}), tc("3", "c", {})],
      finishReason: "tool_calls",
    };
    const out = await s.handleResponse({
      response: r,
      registry: reg,
      signal: new AbortController().signal,
      emit: noEmit,
    });
    expect(order).toEqual(["a", "b", "c"]);
    expect(out.length).toBe(4);
    expect(out.slice(1).map((m) => (m as any).toolCallId)).toEqual(["1", "2", "3"]);
  });

  it("handler throw → tool message with serialized error; subsequent calls still execute", async () => {
    const s = makeStrategy();
    const reg = fakeRegistry({
      a: async () => { throw new Error("boom"); },
      b: async () => "ok",
    });
    const r: LLMResponse = {
      content: "",
      toolCalls: [tc("1", "a", {}), tc("2", "b", {})],
      finishReason: "tool_calls",
    };
    const out = await s.handleResponse({
      response: r,
      registry: reg,
      signal: new AbortController().signal,
      emit: noEmit,
    });
    expect((out[1] as any).content).toBe('{"error":"boom"}');
    expect((out[2] as any).content).toBe("ok");
  });

  it("unknown tool name → serialized error tool message", async () => {
    const s = makeStrategy();
    const r: LLMResponse = {
      content: "",
      toolCalls: [tc("1", "missing", {})],
      finishReason: "tool_calls",
    };
    const out = await s.handleResponse({
      response: r,
      registry: fakeRegistry({}),
      signal: new AbortController().signal,
      emit: noEmit,
    });
    expect((out[1] as any).content).toMatch(/unknown tool/);
  });

  it("malformed arguments (string) skips registry.invoke and emits tool:error", async () => {
    const s = makeStrategy();
    const emit = mock(async () => {});
    const reg = fakeRegistry({ a: async () => { throw new Error("should not be called"); } });
    const r: LLMResponse = {
      content: "",
      toolCalls: [tc("1", "a", "{not json")],
      finishReason: "tool_calls",
    };
    const out = await s.handleResponse({
      response: r,
      registry: reg,
      signal: new AbortController().signal,
      emit: emit as any,
    });
    const parsed = JSON.parse((out[1] as any).content);
    expect(parsed.error).toMatch(/malformed/);
    expect(parsed.raw).toBe("{not json");
    const calls = (emit as any).mock.calls.map((c: any[]) => c[0]);
    expect(calls).toContain("tool:error");
  });

  it("aborted signal mid-loop → remaining calls get 'cancelled' tool messages", async () => {
    const ac = new AbortController();
    const s = makeStrategy();
    const reg = fakeRegistry({
      a: async () => { ac.abort(); return "ra"; }, // first call aborts the signal
      b: async () => "rb",
      c: async () => "rc",
    });
    const r: LLMResponse = {
      content: "",
      toolCalls: [tc("1", "a", {}), tc("2", "b", {}), tc("3", "c", {})],
      finishReason: "tool_calls",
    };
    const out = await s.handleResponse({
      response: r,
      registry: reg,
      signal: ac.signal,
      emit: noEmit,
    });
    expect(out.length).toBe(4);
    expect((out[1] as any).content).toBe("ra");
    expect(JSON.parse((out[2] as any).content)).toEqual({ error: "cancelled" });
    expect(JSON.parse((out[3] as any).content)).toEqual({ error: "cancelled" });
  });

  it("circular result emits tool:error and falls back to String() content", async () => {
    const emit = mock(async () => {});
    const s = makeStrategy();
    const o: any = { a: 1 };
    o.self = o;
    const reg = fakeRegistry({ a: async () => o });
    const r: LLMResponse = {
      content: "",
      toolCalls: [tc("1", "a", {})],
      finishReason: "tool_calls",
    };
    const out = await s.handleResponse({
      response: r,
      registry: reg,
      signal: new AbortController().signal,
      emit: emit as any,
    });
    expect((out[1] as any).content).toBe(String(o));
    const evNames = (emit as any).mock.calls.map((c: any[]) => c[0]);
    expect(evNames).toContain("tool:error");
  });

  it("undefined result → empty content", async () => {
    const s = makeStrategy();
    const reg = fakeRegistry({ a: async () => undefined });
    const r: LLMResponse = {
      content: "",
      toolCalls: [tc("1", "a", {})],
      finishReason: "tool_calls",
    };
    const out = await s.handleResponse({
      response: r,
      registry: reg,
      signal: new AbortController().signal,
      emit: noEmit,
    });
    expect((out[1] as any).content).toBe("");
  });

  it("ctx.log forwards to emit('status:item-update')", async () => {
    const emit = mock(async () => {});
    const s = makeStrategy();
    const reg: ToolsRegistryService = {
      register: () => () => {},
      list: () => [],
      invoke: async (_n, _a, ctx) => { ctx.log("hello"); return "ok"; },
    };
    await s.handleResponse({
      response: { content: "", toolCalls: [tc("c1", "a", {})], finishReason: "tool_calls" },
      registry: reg,
      signal: new AbortController().signal,
      emit: emit as any,
    });
    const statusCall = (emit as any).mock.calls.find((c: any[]) => c[0] === "status:item-update");
    expect(statusCall).toBeDefined();
    expect(statusCall[1]).toEqual({ key: "tool:c1", value: "hello" });
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**

Run: `bun test plugins/llm-native-dispatch/test/strategy.test.ts`
Expected: FAIL — `../strategy.ts` not found.

- [ ] **Step 3: Implement `strategy.ts`**

```ts
import type {
  ChatMessage,
  ToolCall,
  ToolSchema,
  LLMResponse,
} from "llm-events/public";
import type {
  ToolsRegistryService,
  ToolExecutionContext,
} from "llm-tools-registry/public";
import { serializeResult, serializeError } from "./serialize.ts";
import { isValidToolArgs, malformedArgsMessage } from "./args-validation.ts";

export interface ToolDispatchStrategy {
  prepareRequest(input: { availableTools: ToolSchema[] }): { tools?: ToolSchema[]; systemPromptAppend?: string };
  handleResponse(input: {
    response: LLMResponse;
    registry: ToolsRegistryService;
    signal: AbortSignal;
    emit: (event: string, payload: unknown) => Promise<void>;
  }): Promise<ChatMessage[]>;
}

const CANCELLED_CONTENT = JSON.stringify({ error: "cancelled" });

export function makeStrategy(): ToolDispatchStrategy {
  return {
    prepareRequest({ availableTools }) {
      return { tools: availableTools };
    },

    async handleResponse({ response, registry, signal, emit }) {
      const calls = response.toolCalls ?? [];
      if (calls.length === 0) return [];

      const assistant: ChatMessage = {
        role: "assistant",
        content: response.content ?? "",
        toolCalls: calls,
      };
      const out: ChatMessage[] = [assistant];

      for (let i = 0; i < calls.length; i++) {
        const call = calls[i]!;

        if (signal.aborted) {
          // Fill cancelled messages for this and remaining calls.
          for (let j = i; j < calls.length; j++) {
            const c = calls[j]!;
            out.push({
              role: "tool",
              toolCallId: c.id,
              name: c.name,
              content: CANCELLED_CONTENT,
            });
          }
          break;
        }

        if (!isValidToolArgs(call.arguments)) {
          await emit("tool:error", {
            name: call.name,
            callId: call.id,
            message: "malformed arguments JSON from LLM",
          });
          out.push({
            role: "tool",
            toolCallId: call.id,
            name: call.name,
            content: malformedArgsMessage(call.arguments),
          });
          continue;
        }

        const ctx: ToolExecutionContext = {
          signal,
          callId: call.id,
          log: (msg) => { void emit("status:item-update", { key: `tool:${call.id}`, value: msg }); },
        };

        let content: string;
        try {
          const result = await registry.invoke(call.name, call.arguments, ctx);
          const ser = serializeResult(result);
          if (ser.circular) {
            await emit("tool:error", {
              name: call.name,
              callId: call.id,
              message: "result not JSON-serializable, coerced to string",
            });
          }
          content = ser.content;
        } catch (err) {
          const message = String((err as any)?.message ?? err);
          content = serializeError(message);
        }

        out.push({
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content,
        });
      }

      return out;
    },
  };
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `bun test plugins/llm-native-dispatch/test/strategy.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-native-dispatch/strategy.ts plugins/llm-native-dispatch/test/strategy.test.ts
git commit -m "feat(llm-native-dispatch): prepareRequest pass-through + handleResponse loop"
```

---

## Task N5: `index.ts` — wire setup, define and provide service (Tier N3)

**Files:**
- Modify: `plugins/llm-native-dispatch/index.ts`
- Create: `plugins/llm-native-dispatch/test/index.test.ts`

The strategy is a stateless singleton. `setup` only needs to define and provide the service.

- [ ] **Step 1: Write the failing test**

```ts
// plugins/llm-native-dispatch/test/index.test.ts
import { describe, it, expect, mock } from "bun:test";
import plugin from "../index.ts";
import type { ToolDispatchStrategy } from "../strategy.ts";

function makeCtx() {
  const provided: Record<string, unknown> = {};
  return {
    provided,
    log: mock(() => {}),
    config: {},
    defineEvent: mock(() => {}),
    on: mock(() => {}),
    emit: mock(async () => []),
    defineService: mock(() => {}),
    provideService: mock((name: string, impl: unknown) => { provided[name] = impl; }),
    consumeService: mock(() => {}),
    useService: mock(() => undefined),
    secrets: { get: mock(async () => undefined), refresh: mock(async () => undefined) },
  } as any;
}

describe("llm-native-dispatch plugin", () => {
  it("metadata", () => {
    expect(plugin.name).toBe("llm-native-dispatch");
    expect(plugin.apiVersion).toBe("3.0.0");
    expect(plugin.permissions).toEqual({ tier: "trusted" });
    expect(plugin.services?.provides).toContain("tool-dispatch:strategy");
    expect(plugin.services?.consumes).toContain("tools:registry");
    expect(plugin.services?.consumes).toContain("llm-events:vocabulary");
  });

  it("setup defines and provides tool-dispatch:strategy", async () => {
    const ctx = makeCtx();
    await plugin.setup(ctx);
    expect(ctx.defineService).toHaveBeenCalledWith("tool-dispatch:strategy", expect.objectContaining({ description: expect.any(String) }));
    const svc = ctx.provided["tool-dispatch:strategy"] as ToolDispatchStrategy;
    expect(svc).toBeDefined();
    expect(typeof svc.prepareRequest).toBe("function");
    expect(typeof svc.handleResponse).toBe("function");
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Replace placeholder `index.ts`**

```ts
import type { KaizenPlugin } from "kaizen/types";
import { makeStrategy } from "./strategy.ts";
import type { ToolDispatchStrategy } from "./strategy.ts";

const plugin: KaizenPlugin = {
  name: "llm-native-dispatch",
  apiVersion: "3.0.0",
  permissions: { tier: "trusted" },
  services: {
    provides: ["tool-dispatch:strategy"],
    consumes: ["tools:registry", "llm-events:vocabulary"],
  },

  async setup(ctx) {
    ctx.defineService("tool-dispatch:strategy", {
      description: "Native OpenAI tool-calling dispatch strategy.",
    });
    ctx.provideService<ToolDispatchStrategy>("tool-dispatch:strategy", makeStrategy());
  },
};

export default plugin;
```

- [ ] **Step 4: Run, expect PASS**

Run: `bun test plugins/llm-native-dispatch/`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-native-dispatch/index.ts plugins/llm-native-dispatch/test/index.test.ts
git commit -m "feat(llm-native-dispatch): wire setup() to provide tool-dispatch:strategy"
```

---

## Task N6: `public.d.ts` — final re-exports (Tier N3)

**Files:**
- Modify: `plugins/llm-native-dispatch/public.d.ts`

- [ ] **Step 1: Replace `public.d.ts` with final form**

```ts
// llm-native-dispatch public surface — re-exports only.
// Spec 0 owns the underlying contract via shared types in llm-events.

export type { ToolDispatchStrategy } from "./strategy";
```

- [ ] **Step 2: Acceptance grep — no Spec 0 type re-declared**

Run: `grep -nE "interface (LLMResponse|ToolSchema|ToolCall|ChatMessage)" plugins/llm-native-dispatch/`
Expected: NO matches.

- [ ] **Step 3: Type-check the package**

Run: `bun --bun tsc --noEmit -p plugins/llm-native-dispatch/tsconfig.json plugins/llm-native-dispatch/index.ts plugins/llm-native-dispatch/strategy.ts plugins/llm-native-dispatch/serialize.ts plugins/llm-native-dispatch/args-validation.ts plugins/llm-native-dispatch/public.d.ts`
Expected: no diagnostics.

- [ ] **Step 4: Commit (if changed)**

```bash
git add plugins/llm-native-dispatch/public.d.ts
git commit -m "chore(llm-native-dispatch): finalize public.d.ts re-exports" || echo "no changes"
```

---

## Task F1: Cross-plugin integration test (Tier F)

**Files:**
- Create: `plugins/llm-native-dispatch/test/integration.test.ts`

Verifies the two plugins compose: strategy invokes the real registry, the real registry emits `tool:*` events, error and success paths produce well-formed conversation messages. This is the end-to-end test the spec calls for at the plugin pair level (the full B-tier harness end-to-end test belongs to the `llm-driver` spec, not here).

- [ ] **Step 1: Write the failing test**

```ts
// plugins/llm-native-dispatch/test/integration.test.ts
import { describe, it, expect, mock } from "bun:test";
import { makeRegistry } from "llm-tools-registry/registry";
import { makeStrategy } from "../strategy.ts";
import type { LLMResponse, ToolCall } from "llm-events/public";

function tc(id: string, name: string, args: unknown): ToolCall { return { id, name, arguments: args }; }

describe("integration: registry + strategy", () => {
  it("happy path: strategy → registry.invoke emits tool:* events; conversation is well-formed", async () => {
    const events: { name: string; payload: any }[] = [];
    const emit = mock(async (n: string, p: any) => { events.push({ name: n, payload: p }); });
    const registry = makeRegistry(emit as any);
    registry.register(
      { name: "echo", description: "", parameters: { type: "object" } as any },
      async (a) => ({ got: a }),
    );
    const strategy = makeStrategy();

    const response: LLMResponse = {
      content: "",
      toolCalls: [tc("c1", "echo", { x: 1 })],
      finishReason: "tool_calls",
    };
    const out = await strategy.handleResponse({
      response,
      registry,
      signal: new AbortController().signal,
      emit: emit as any,
    });

    expect(out.length).toBe(2);
    expect(out[0]).toMatchObject({ role: "assistant" });
    expect(out[1]).toMatchObject({ role: "tool", toolCallId: "c1", name: "echo", content: '{"got":{"x":1}}' });

    const toolEvents = events.filter((e) => e.name.startsWith("tool:")).map((e) => e.name);
    expect(toolEvents).toEqual(["tool:before-execute", "tool:execute", "tool:result"]);
  });

  it("unknown tool: registry emits tool:error; strategy still produces well-formed tool message", async () => {
    const events: { name: string; payload: any }[] = [];
    const emit = mock(async (n: string, p: any) => { events.push({ name: n, payload: p }); });
    const registry = makeRegistry(emit as any);
    const strategy = makeStrategy();

    const response: LLMResponse = {
      content: "",
      toolCalls: [tc("c1", "missing", {})],
      finishReason: "tool_calls",
    };
    const out = await strategy.handleResponse({
      response,
      registry,
      signal: new AbortController().signal,
      emit: emit as any,
    });

    expect(out.length).toBe(2);
    expect((out[1] as any).content).toMatch(/unknown tool/);
    const toolErr = events.find((e) => e.name === "tool:error");
    expect(toolErr).toBeDefined();
    expect(toolErr?.payload).toMatchObject({ name: "missing", callId: "c1" });
  });

  it("CANCEL_TOOL via subscriber: strategy receives rejection and produces error tool message", async () => {
    const { CANCEL_TOOL } = await import("llm-events/public");
    const subscribers: Record<string, ((p: any) => void)[]> = {};
    const emit = async (n: string, p: any) => {
      for (const fn of subscribers[n] ?? []) fn(p);
    };
    subscribers["tool:before-execute"] = [(p: any) => { p.args = CANCEL_TOOL; }];

    const registry = makeRegistry(emit as any);
    registry.register(
      { name: "noop", description: "", parameters: { type: "object" } as any },
      async () => "should not be called",
    );
    const strategy = makeStrategy();

    const response: LLMResponse = {
      content: "",
      toolCalls: [tc("c1", "noop", {})],
      finishReason: "tool_calls",
    };
    const out = await strategy.handleResponse({
      response,
      registry,
      signal: new AbortController().signal,
      emit: emit as any,
    });

    expect(out.length).toBe(2);
    const parsed = JSON.parse((out[1] as any).content);
    expect(parsed.error).toMatch(/cancelled/);
  });

  it("two parallel-ish tool calls execute sequentially through the registry", async () => {
    const order: string[] = [];
    const emit = mock(async () => {});
    const registry = makeRegistry(emit as any);
    registry.register(
      { name: "a", description: "", parameters: { type: "object" } as any },
      async () => { order.push("a-start"); await new Promise((r) => setTimeout(r, 5)); order.push("a-end"); return "ra"; },
    );
    registry.register(
      { name: "b", description: "", parameters: { type: "object" } as any },
      async () => { order.push("b-start"); order.push("b-end"); return "rb"; },
    );
    const strategy = makeStrategy();

    const response: LLMResponse = {
      content: "",
      toolCalls: [tc("1", "a", {}), tc("2", "b", {})],
      finishReason: "tool_calls",
    };
    await strategy.handleResponse({
      response,
      registry,
      signal: new AbortController().signal,
      emit: emit as any,
    });
    expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });
});
```

- [ ] **Step 2: Run, expect PASS**

Run: `bun test plugins/llm-native-dispatch/test/integration.test.ts`
Expected: all tests PASS. (No production code changes are required; this test verifies what the previous tasks already built.)

If FAIL: do NOT modify production code without re-checking the spec — the previous tasks should already satisfy these assertions. The most likely cause is a missing workspace dep on `llm-tools-registry` in `plugins/llm-native-dispatch/package.json`. If so, add the dep, `bun install`, re-run.

- [ ] **Step 3: Run full test sweep across both plugins**

Run: `bun test plugins/llm-tools-registry plugins/llm-native-dispatch`
Expected: all tests PASS.

- [ ] **Step 4: Commit**

```bash
git add plugins/llm-native-dispatch/test/integration.test.ts
git commit -m "test(llm-native-dispatch): cross-plugin integration with real registry"
```

---

## Task F2: Marketplace catalog update (Tier F)

**Files:**
- Modify: `.kaizen/marketplace.json`

- [ ] **Step 1: Read current `entries` array**

Run: `bun -e "console.log(JSON.parse(require('node:fs').readFileSync('.kaizen/marketplace.json','utf8')).entries.map(e=>e.name).join('\\n'))"`
Expected: includes `claude-events`, `claude-tui`, `claude-status-items`, `claude-driver`, `llm-events`, `openai-llm`, `claude-wrapper`.

- [ ] **Step 2: Insert two new plugin entries after `openai-llm`, before `claude-wrapper`**

Add to `.kaizen/marketplace.json`'s `entries` array:

```jsonc
    {
      "kind": "plugin",
      "name": "llm-tools-registry",
      "description": "Central tool registry and single tool-execution chokepoint for the openai-compatible harness.",
      "categories": ["tools", "registry"],
      "versions": [{ "version": "0.1.0", "source": { "type": "file", "path": "plugins/llm-tools-registry" } }]
    },
    {
      "kind": "plugin",
      "name": "llm-native-dispatch",
      "description": "Native OpenAI tool-calling dispatch strategy (alternate to code-mode).",
      "categories": ["tools", "dispatch"],
      "versions": [{ "version": "0.1.0", "source": { "type": "file", "path": "plugins/llm-native-dispatch" } }]
    },
```

- [ ] **Step 3: Validate JSON**

Run: `bun -e "JSON.parse(require('node:fs').readFileSync('.kaizen/marketplace.json','utf8'))"`
Expected: no error.

- [ ] **Step 4: Final test sweep**

Run: `bun test plugins/llm-tools-registry plugins/llm-native-dispatch`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add .kaizen/marketplace.json
git commit -m "chore(marketplace): publish llm-tools-registry@0.1.0 and llm-native-dispatch@0.1.0"
```

---

## Spec coverage summary

| Spec 4 section | Task |
|---|---|
| Plugin 1 (`llm-tools-registry`) plugin shape | Task R1, R4 |
| `register` validation, duplicate-throw, reference-identity unregister | Task R2 |
| `list` (filter tags, names, AND, insertion order, snapshot) | Task R2 |
| `invoke` event sequence (before-execute, execute, result/error) | Task R2 |
| Mutation of `payload.args` by subscriber observed by handler | Task R2 |
| `CANCEL_TOOL` sentinel short-circuits invocation | Task R2 |
| Unknown tool → `tool:error` only, no `before-execute` | Task R2 |
| Handler throw → `tool:error` + re-reject original | Task R2 |
| Concurrent invocations independent | Task R2 |
| `CANCEL_TOOL` exported via `public.d.ts` (well-known symbol identity) | Task R3 |
| `tools:registry` service exposed; only registry public surface | Task R4 |
| Plugin 2 (`llm-native-dispatch`) plugin shape | Task N1, N5 |
| `prepareRequest` pass-through; no `systemPromptAppend`; empty-tools handling | Task N4 |
| `handleResponse` Case A — terminal returns `[]` | Task N4 |
| `handleResponse` Case B — `[assistantMessage, ...toolMessages]` | Task N4 |
| Sequential tool execution in `response.toolCalls` order | Task N4 |
| `ctx.log` forwarding via `status:item-update` | Task N4 |
| Handler throw → tool message with serialized error; loop continues | Task N4 |
| Unknown tool → tool message with serialized error; loop continues | Task N4 |
| Result serialization (string, undefined/null, JSON, circular fallback) | Tasks N2, N4 |
| Malformed `arguments` defensive handling | Tasks N3, N4 |
| `signal` aborts mid-loop → cancelled tool messages for remaining calls | Task N4 |
| `tool-dispatch:strategy` service exposed via Spec 0 contract | Task N5, N6 |
| Cross-plugin integration (registry + strategy compose) | Task F1 |
| Marketplace `entries` updated for both plugins | Task F2 |
| No persistence, no fs/network I/O | Tasks R2, N4 (no I/O introduced) |

## Self-review notes (applied)

- Spec 0's `ToolExecutionContext` includes optional `turnId`. Native dispatch does not have turn context (the driver passes it down once it integrates), so the strategy builds `ctx` without `turnId`. The `llm-driver` spec is responsible for forwarding `turnId` when it consumes this strategy. The registry's `ToolExecutionContext` interface is permissive (`turnId?`) so this is contract-safe.
- Spec 4 says the registry "awaits all subscribers (the bus's normal sequential dispatch is sufficient)". Task R2 relies on `ctx.emit` to await subscribers per the Kaizen bus contract; the unit test models this with an inline subscriber registration and a single `await`.
- The cancellation sentinel test in R2 confirms `Symbol.for("kaizen.cancel")` identity (re-exported from `llm-events`), satisfying the well-known-key acceptance criterion.
- The pluggable-registry constraint: `llm-native-dispatch` only depends on the `ToolsRegistryService` interface from `llm-events`/`llm-tools-registry`. A future `llm-codemode-dispatch` (Spec 5) plugs into the same registry instance via the same service contract — no changes to either plugin in this plan are needed for that.
- Spec 4 §Acceptance: "no plugin imports any other plugin's runtime code (only types)". Verified — `llm-native-dispatch/strategy.ts` imports only types from `llm-tools-registry/public` and `llm-events/public`. The integration test in F1 imports `makeRegistry` from `llm-tools-registry/registry` because tests are not "plugin runtime code".
- The `args-validation` rule is conservative: strings as `arguments` are flagged as malformed. This matches Spec 4's stated intent ("a string (the unparsed body)"). Spec 4 Open Questions note this is pending tightening once Spec 1 pins the exact failure-mode contract from `openai-llm`; this plan's behavior is the defensive default the spec calls for.
- Aborted-signal test in N4 deliberately triggers the abort *inside* the first handler rather than before the loop starts, because the spec says cancellation is observed "mid-loop". The check happens at the top of each subsequent iteration, before `registry.invoke` is called.
