# `/status:show` Slash Command + Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the live contents of the status bar via a `/status:show` slash command and a `status:show` tool peer, so both the human and the LLM can read provider-reported context-window / token / throughput / cost numbers on demand.

**Architecture:** Add three new files inside `llm-status-items` — a pure `snapshot.ts` projector over the existing `StatusState`, a `slash.ts` adapter that prints a human-readable block, and a `tool.ts` adapter that returns the snapshot as JSON. Wire both adapters in `index.ts` on `harness:start`, consuming `slash:registry` and `tools:registry` softly (mirrors the precedent set by `llm-session-manager`). No changes to the reducer, no estimation, no tokenizer.

**Tech Stack:** TypeScript, Bun (`bun:test`), `kaizen` plugin runtime, `llm-slash-commands`, `llm-tools-registry`.

**Spec:** `docs/superpowers/specs/2026-05-09-status-show-design.md`

---

## File Structure

**Create:**
- `plugins/llm-status-items/snapshot.ts` — `buildSnapshot(state, costCents) → StatusSnapshot`. Pure.
- `plugins/llm-status-items/slash.ts` — `registerStatusSlash(slash, getSnapshot) → off[]`. Adapter.
- `plugins/llm-status-items/tool.ts` — `registerStatusTool(tools, getSnapshot) → off[]`. Adapter.
- `plugins/llm-status-items/test/snapshot.test.ts`
- `plugins/llm-status-items/test/slash.test.ts`
- `plugins/llm-status-items/test/tool.test.ts`

**Modify:**
- `plugins/llm-status-items/index.ts` — track `costCents` + `costPriced`; register adapters on `harness:start`.
- `plugins/llm-status-items/test/index.test.ts` — one parity test asserting both adapters surface from the same `StatusState`.
- `plugins/llm-status-items/package.json` — bump no version (internal-only change). Skip unless required by repo convention; check before editing.

**Don't touch:**
- `state.ts`, `cost.ts`, `context.ts` — pure modules; snapshot reads from `StatusState` only.

---

## Task 1: `StatusSnapshot` shape and pure projector

**Files:**
- Create: `plugins/llm-status-items/snapshot.ts`
- Test:   `plugins/llm-status-items/test/snapshot.test.ts`

- [ ] **Step 1: Write the failing test**

Create `plugins/llm-status-items/test/snapshot.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { buildSnapshot } from "../snapshot.ts";
import { initialState, type StatusState } from "../state.ts";

function makeState(overrides: Partial<StatusState> = {}): StatusState {
  return { ...initialState(), ...overrides };
}

describe("buildSnapshot", () => {
  it("projects defaults from initialState with null costCents", () => {
    const snap = buildSnapshot(makeState(), null);
    expect(snap).toEqual({
      model: null,
      session: { id: null, alias: null },
      contextWindow: { lastPromptTokens: 0, contextLength: null, pctUsed: null },
      sessionTotals: { promptTokens: 0, completionTokens: 0 },
      tokensPerSec: null,
      costCents: null,
    });
  });

  it("computes pctUsed when contextLength is positive", () => {
    const snap = buildSnapshot(
      makeState({ lastPromptTokens: 4096, contextLength: 8192 }),
      null,
    );
    expect(snap.contextWindow.pctUsed).toBe(0.5);
  });

  it("leaves pctUsed null when contextLength is null", () => {
    const snap = buildSnapshot(makeState({ lastPromptTokens: 1000 }), null);
    expect(snap.contextWindow.pctUsed).toBeNull();
  });

  it("leaves pctUsed null when contextLength is zero (defensive)", () => {
    const snap = buildSnapshot(
      makeState({ lastPromptTokens: 1000, contextLength: 0 }),
      null,
    );
    expect(snap.contextWindow.pctUsed).toBeNull();
  });

  it("passes costCents through verbatim", () => {
    const snap = buildSnapshot(makeState(), 1.23);
    expect(snap.costCents).toBe(1.23);
  });

  it("surfaces session id, alias, model, totals, and tok/s", () => {
    const snap = buildSnapshot(
      makeState({
        model: "gpt-4o-mini",
        sessionId: "abc",
        sessionAlias: "demo",
        promptTokens: 12303,
        completionTokens: 2103,
        tokensPerSec: 87.4,
      }),
      45.6,
    );
    expect(snap.model).toBe("gpt-4o-mini");
    expect(snap.session).toEqual({ id: "abc", alias: "demo" });
    expect(snap.sessionTotals).toEqual({ promptTokens: 12303, completionTokens: 2103 });
    expect(snap.tokensPerSec).toBe(87.4);
    expect(snap.costCents).toBe(45.6);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/llm-status-items && bun test test/snapshot.test.ts`
Expected: FAIL — `Cannot find module '../snapshot.ts'`.

- [ ] **Step 3: Implement `snapshot.ts`**

Create `plugins/llm-status-items/snapshot.ts`:

```ts
import type { StatusState } from "./state.ts";

export interface StatusSnapshot {
  model: string | null;
  session: { id: string | null; alias: string | null };
  contextWindow: {
    lastPromptTokens: number;
    contextLength: number | null;
    pctUsed: number | null;
  };
  sessionTotals: {
    promptTokens: number;
    completionTokens: number;
  };
  tokensPerSec: number | null;
  costCents: number | null;
}

export function buildSnapshot(state: StatusState, costCents: number | null): StatusSnapshot {
  const { contextLength, lastPromptTokens } = state;
  const pctUsed = contextLength && contextLength > 0
    ? lastPromptTokens / contextLength
    : null;
  return {
    model: state.model,
    session: { id: state.sessionId, alias: state.sessionAlias },
    contextWindow: { lastPromptTokens, contextLength, pctUsed },
    sessionTotals: {
      promptTokens: state.promptTokens,
      completionTokens: state.completionTokens,
    },
    tokensPerSec: state.tokensPerSec,
    costCents,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd plugins/llm-status-items && bun test test/snapshot.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-status-items/snapshot.ts plugins/llm-status-items/test/snapshot.test.ts
git commit -m "feat(llm-status-items): add buildSnapshot pure projector"
```

---

## Task 2: `/status:show` slash adapter

**Files:**
- Create: `plugins/llm-status-items/slash.ts`
- Test:   `plugins/llm-status-items/test/slash.test.ts`

- [ ] **Step 1: Write the failing test**

Create `plugins/llm-status-items/test/slash.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { registerStatusSlash, type SlashRegistryLike, type SlashCommandManifestLike, type SlashCommandContextLike } from "../slash.ts";
import type { StatusSnapshot } from "../snapshot.ts";

interface Registered {
  manifest: SlashCommandManifestLike;
  handler: (ctx: SlashCommandContextLike) => Promise<void>;
}

function makeFakeRegistry(): { reg: SlashRegistryLike; entries: Registered[] } {
  const entries: Registered[] = [];
  const reg: SlashRegistryLike = {
    register(manifest, handler) {
      entries.push({ manifest, handler });
      return () => {};
    },
  };
  return { reg, entries };
}

function fullSnapshot(): StatusSnapshot {
  return {
    model: "gpt-4o-mini",
    session: { id: "abc12345-6789-0000-0000-000000000000", alias: "demo" },
    contextWindow: { lastPromptTokens: 3421, contextLength: 8192, pctUsed: 3421 / 8192 },
    sessionTotals: { promptTokens: 12303, completionTokens: 2103 },
    tokensPerSec: 87.4,
    costCents: 1.23,
  };
}

async function invoke(snap: StatusSnapshot): Promise<string> {
  const { reg, entries } = makeFakeRegistry();
  registerStatusSlash(reg, () => snap);
  expect(entries.length).toBe(1);
  expect(entries[0]!.manifest.name).toBe("status:show");
  expect(entries[0]!.manifest.source).toBe("plugin");
  const printed: string[] = [];
  await entries[0]!.handler({ args: "", print: async (t) => { printed.push(t); } });
  expect(printed.length).toBe(1);
  return printed[0]!;
}

describe("/status:show slash adapter", () => {
  it("renders all fields when populated", async () => {
    const text = await invoke(fullSnapshot());
    expect(text).toContain("model:           gpt-4o-mini");
    expect(text).toContain("session:         abc12345-6789-0000-0000-000000000000 (demo)");
    expect(text).toContain("context window:  3,421 / 8,192  (42%)");
    expect(text).toContain("session totals:  in=12,303  out=2,103");
    expect(text).toContain("tok/s (last):    87.4");
    expect(text).toContain("cost (est):      $0.0123");
  });

  it("renders integer tok/s when >= 10", async () => {
    const snap = fullSnapshot();
    snap.tokensPerSec = 123.7;
    const text = await invoke(snap);
    expect(text).toContain("tok/s (last):    124");
  });

  it("formats session as id-only when alias is null", async () => {
    const snap = fullSnapshot();
    snap.session.alias = null;
    const text = await invoke(snap);
    expect(text).toContain("session:         abc12345-6789-0000-0000-000000000000");
    expect(text).not.toContain("(");
  });

  it("omits session line when id is null", async () => {
    const snap = fullSnapshot();
    snap.session = { id: null, alias: null };
    const text = await invoke(snap);
    expect(text).not.toContain("session:");
  });

  it("omits model line when model is null", async () => {
    const snap = fullSnapshot();
    snap.model = null;
    const text = await invoke(snap);
    expect(text).not.toContain("model:");
  });

  it("omits ceiling and percentage when contextLength is null", async () => {
    const snap = fullSnapshot();
    snap.contextWindow = { lastPromptTokens: 3421, contextLength: null, pctUsed: null };
    const text = await invoke(snap);
    expect(text).toContain("context window:  3,421");
    expect(text).not.toContain("/");
    expect(text).not.toContain("%");
  });

  it("omits tok/s line when null", async () => {
    const snap = fullSnapshot();
    snap.tokensPerSec = null;
    const text = await invoke(snap);
    expect(text).not.toContain("tok/s");
  });

  it("omits cost line when null", async () => {
    const snap = fullSnapshot();
    snap.costCents = null;
    const text = await invoke(snap);
    expect(text).not.toContain("cost");
  });

  it("formats fractional cost correctly", async () => {
    const snap = fullSnapshot();
    snap.costCents = 0.5;       // half a cent → $0.0050
    const text = await invoke(snap);
    expect(text).toContain("cost (est):      $0.0050");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/llm-status-items && bun test test/slash.test.ts`
Expected: FAIL — `Cannot find module '../slash.ts'`.

- [ ] **Step 3: Implement `slash.ts`**

Create `plugins/llm-status-items/slash.ts`:

```ts
import type { StatusSnapshot } from "./snapshot.ts";

export interface SlashCommandManifestLike {
  name: string;
  description: string;
  source: "builtin" | "plugin";
  usage?: string;
}
export interface SlashCommandContextLike {
  args: string;
  print: (text: string) => Promise<void>;
}
export interface SlashRegistryLike {
  register(manifest: SlashCommandManifestLike, handler: (ctx: SlashCommandContextLike) => Promise<void>): () => void;
}

const NUM = new Intl.NumberFormat("en-US");

function formatTokensPerSec(v: number): string {
  return v >= 10 ? v.toFixed(0) : v.toFixed(1);
}

function formatDollars(cents: number): string {
  return `$${(cents / 100).toFixed(4)}`;
}

export function formatSnapshot(snap: StatusSnapshot): string {
  const lines: string[] = [];

  if (snap.model) {
    lines.push(`model:           ${snap.model}`);
  }
  if (snap.session.id) {
    const sess = snap.session.alias
      ? `${snap.session.id} (${snap.session.alias})`
      : snap.session.id;
    lines.push(`session:         ${sess}`);
  }

  // Context window line: always rendered. Ceiling + % only when known.
  const used = NUM.format(snap.contextWindow.lastPromptTokens);
  if (snap.contextWindow.contextLength != null && snap.contextWindow.pctUsed != null) {
    const ceiling = NUM.format(snap.contextWindow.contextLength);
    const pct = Math.round(snap.contextWindow.pctUsed * 100);
    lines.push(`context window:  ${used} / ${ceiling}  (${pct}%)`);
  } else {
    lines.push(`context window:  ${used}`);
  }

  lines.push(
    `session totals:  in=${NUM.format(snap.sessionTotals.promptTokens)}  ` +
      `out=${NUM.format(snap.sessionTotals.completionTokens)}`,
  );

  if (snap.tokensPerSec != null) {
    lines.push(`tok/s (last):    ${formatTokensPerSec(snap.tokensPerSec)}`);
  }
  if (snap.costCents != null) {
    lines.push(`cost (est):      ${formatDollars(snap.costCents)}`);
  }

  return lines.join("\n");
}

export function registerStatusSlash(
  slash: SlashRegistryLike,
  getSnapshot: () => StatusSnapshot,
): Array<() => void> {
  const off = slash.register(
    {
      name: "status:show",
      description: "Show current status-bar values: model, context-window usage, session token totals, throughput, and cost.",
      source: "plugin",
    },
    async (ctx) => {
      await ctx.print(formatSnapshot(getSnapshot()));
    },
  );
  return [off];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd plugins/llm-status-items && bun test test/slash.test.ts`
Expected: PASS — 9 tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-status-items/slash.ts plugins/llm-status-items/test/slash.test.ts
git commit -m "feat(llm-status-items): add /status:show slash adapter"
```

---

## Task 3: `status:show` tool adapter

**Files:**
- Create: `plugins/llm-status-items/tool.ts`
- Test:   `plugins/llm-status-items/test/tool.test.ts`

- [ ] **Step 1: Write the failing test**

Create `plugins/llm-status-items/test/tool.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { registerStatusTool, type ToolsRegistryLike, type ToolHandlerLike } from "../tool.ts";
import type { StatusSnapshot } from "../snapshot.ts";
import type { ToolSchema } from "llm-events/public";

interface Registered {
  schema: ToolSchema;
  handler: ToolHandlerLike;
}

function makeFakeRegistry(): { reg: ToolsRegistryLike; entries: Registered[] } {
  const entries: Registered[] = [];
  const reg: ToolsRegistryLike = {
    register(schema, handler) {
      entries.push({ schema, handler });
      return () => {};
    },
  };
  return { reg, entries };
}

function snap(): StatusSnapshot {
  return {
    model: "gpt-4o-mini",
    session: { id: "abc", alias: null },
    contextWindow: { lastPromptTokens: 100, contextLength: 1000, pctUsed: 0.1 },
    sessionTotals: { promptTokens: 100, completionTokens: 50 },
    tokensPerSec: 12.3,
    costCents: null,
  };
}

describe("status:show tool adapter", () => {
  it("registers a tool named 'status:show' with zero-arg schema", () => {
    const { reg, entries } = makeFakeRegistry();
    registerStatusTool(reg, snap);
    expect(entries.length).toBe(1);
    expect(entries[0]!.schema.name).toBe("status:show");
    expect(entries[0]!.schema.parameters).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
  });

  it("returns the snapshot verbatim from the getter", async () => {
    const { reg, entries } = makeFakeRegistry();
    const fixed = snap();
    registerStatusTool(reg, () => fixed);
    const fakeCtx = {
      signal: new AbortController().signal,
      callId: "call-1",
      log: () => {},
    };
    const result = await entries[0]!.handler({}, fakeCtx);
    expect(result).toBe(fixed);
  });

  it("re-evaluates the getter on every invocation", async () => {
    const { reg, entries } = makeFakeRegistry();
    let n = 0;
    registerStatusTool(reg, () => ({ ...snap(), tokensPerSec: ++n }));
    const fakeCtx = {
      signal: new AbortController().signal,
      callId: "c",
      log: () => {},
    };
    const r1 = (await entries[0]!.handler({}, fakeCtx)) as StatusSnapshot;
    const r2 = (await entries[0]!.handler({}, fakeCtx)) as StatusSnapshot;
    expect(r1.tokensPerSec).toBe(1);
    expect(r2.tokensPerSec).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/llm-status-items && bun test test/tool.test.ts`
Expected: FAIL — `Cannot find module '../tool.ts'`.

- [ ] **Step 3: Implement `tool.ts`**

Create `plugins/llm-status-items/tool.ts`:

```ts
import type { ToolSchema } from "llm-events/public";
import type { StatusSnapshot } from "./snapshot.ts";

export interface ToolHandlerLike {
  (args: any, ctx: { signal: AbortSignal; callId: string; log: (m: string) => void }): Promise<unknown>;
}
export interface ToolsRegistryLike {
  register(schema: ToolSchema, handler: ToolHandlerLike): () => void;
}

export function registerStatusTool(
  tools: ToolsRegistryLike,
  getSnapshot: () => StatusSnapshot,
): Array<() => void> {
  const off = tools.register(
    {
      name: "status:show",
      description:
        "Return current status-bar values: model, context-window usage (lastPromptTokens / contextLength / pctUsed), cumulative session token totals, last-turn tokens/sec, and cost estimate. All numbers are reported by the provider — no estimation. Useful for deciding whether to clear context.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      } as any,
    },
    async () => getSnapshot(),
  );
  return [off];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd plugins/llm-status-items && bun test test/tool.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-status-items/tool.ts plugins/llm-status-items/test/tool.test.ts
git commit -m "feat(llm-status-items): add status:show tool adapter"
```

---

## Task 4: Wire snapshot getter and register both adapters in `index.ts`

**Files:**
- Modify: `plugins/llm-status-items/index.ts`
- Test:   `plugins/llm-status-items/test/index.test.ts` (append)

- [ ] **Step 1: Read the current `index.ts` to confirm insertion points**

Re-read `plugins/llm-status-items/index.ts` — note:
- `costCents` is a local in `setup()` (~line 40).
- `costActive` is set to true after a successful priced emit (~line 215).
- `emitCost` clears via `costActive` when model becomes unpriced (~line 203-207).
- The subscription loop ends at the close of `setup()`.

We will:
1. Track a `costPriced` flag mirroring the rules of `costActive` (true only after the most recent priced `llm:done`; reset to false on conversation:cleared and on any unpriced llm:done). `costActive` already encodes this exactly — reuse it.
2. Add a `getSnapshot = () => buildSnapshot(state, costActive ? costCents : null)` closure.
3. Register both adapters on `harness:start`, soft via try/catch.

- [ ] **Step 2: Write the failing parity test**

Append to `plugins/llm-status-items/test/index.test.ts`:

```ts
describe("status:show slash + tool registration", () => {
  it("registers /status:show on slash:registry and 'status:show' on tools:registry on harness:start", async () => {
    const ctx = makeCtx();
    const slashRegistered: Array<{ name: string }> = [];
    const toolsRegistered: Array<{ name: string }> = [];
    ctx.useService = mock((id: string) => {
      if (id === "slash:registry") {
        return {
          register: (manifest: any) => {
            slashRegistered.push({ name: manifest.name });
            return () => {};
          },
        };
      }
      if (id === "tools:registry") {
        return {
          register: (schema: any) => {
            toolsRegistered.push({ name: schema.name });
            return () => {};
          },
        };
      }
      return undefined;
    });
    await plugin.setup(ctx);
    await ctx.handlers["harness:start"]!({});
    expect(slashRegistered.map((e) => e.name)).toContain("status:show");
    expect(toolsRegistered.map((e) => e.name)).toContain("status:show");
  });

  it("slash and tool adapters reflect the same snapshot derived from StatusState", async () => {
    const ctx = makeCtx();
    let slashHandler: ((ctx: { args: string; print: (t: string) => Promise<void> }) => Promise<void>) | null = null;
    let toolHandler: ((args: any, ctx: any) => Promise<unknown>) | null = null;
    ctx.useService = mock((id: string) => {
      if (id === "slash:registry") {
        return {
          register: (manifest: any, h: any) => {
            if (manifest.name === "status:show") slashHandler = h;
            return () => {};
          },
        };
      }
      if (id === "tools:registry") {
        return {
          register: (schema: any, h: any) => {
            if (schema.name === "status:show") toolHandler = h;
            return () => {};
          },
        };
      }
      return undefined;
    });
    await plugin.setup(ctx);
    await ctx.handlers["harness:start"]!({});
    // Drive some state through the reducer.
    await ctx.handlers["llm:before-call"]!({ request: { model: "gpt-4o-mini" } });
    await ctx.handlers["llm:done"]!({
      response: { usage: { promptTokens: 100, completionTokens: 50 } },
    });

    const printed: string[] = [];
    await slashHandler!({ args: "", print: async (t) => { printed.push(t); } });
    const toolResult = (await toolHandler!({}, { signal: new AbortController().signal, callId: "c", log: () => {} })) as any;

    expect(printed[0]).toContain("model:           gpt-4o-mini");
    expect(printed[0]).toContain("in=100");
    expect(printed[0]).toContain("out=50");
    expect(toolResult.model).toBe("gpt-4o-mini");
    expect(toolResult.sessionTotals).toEqual({ promptTokens: 100, completionTokens: 50 });
    expect(toolResult.contextWindow.lastPromptTokens).toBe(100);
  });

  it("works without slash:registry or tools:registry (both soft)", async () => {
    const ctx = makeCtx();
    ctx.useService = mock(() => undefined);
    await plugin.setup(ctx);
    // Should not throw.
    await ctx.handlers["harness:start"]!({});
  });
});
```

- [ ] **Step 3: Run the new tests to verify they fail**

Run: `cd plugins/llm-status-items && bun test test/index.test.ts`
Expected: the three new tests FAIL — `slash:registry` / `tools:registry` not consulted, no `status:show` registration.

- [ ] **Step 4: Modify `index.ts` to wire the adapters**

In `plugins/llm-status-items/index.ts`:

a) Add imports at the top (after existing imports):

```ts
import { buildSnapshot } from "./snapshot.ts";
import { registerStatusSlash, type SlashRegistryLike } from "./slash.ts";
import { registerStatusTool, type ToolsRegistryLike } from "./tool.ts";
```

b) Add `slash:registry` and `tools:registry` to `services.consumes` (currently `["llm-events:vocabulary", "llm:complete"]`):

```ts
services: { consumes: ["llm-events:vocabulary", "llm:complete", "slash:registry", "tools:registry"] },
```

c) After the existing `for (const name of SUBSCRIBED) { ... }` loop in `setup()`, append the registration block. The closure reads `state` and `costCents`/`costActive` from the enclosing scope, so it always returns the live snapshot:

```ts
    // Snapshot getter for /status:show + status:show tool. Reads `state`,
    // `costCents`, and `costActive` from this closure so every call returns
    // current values without any caching.
    const getSnapshot = () => buildSnapshot(state, costActive ? costCents : null);

    // Soft registration on harness:start — slash and tools registries are
    // optional peers. Both adapters are thin wrappers around the same
    // getSnapshot closure; either can be absent without affecting the other.
    ctx.on("harness:start", () => {
      try {
        const slash = ctx.useService<SlashRegistryLike>("slash:registry");
        if (slash) registerStatusSlash(slash, getSnapshot);
      } catch { /* slash:registry absent — skip */ }
      try {
        const toolsReg = ctx.useService<ToolsRegistryLike>("tools:registry");
        if (toolsReg) registerStatusTool(toolsReg, getSnapshot);
      } catch { /* tools:registry absent — skip */ }
    });
```

Note: `harness:start` is already in `SUBSCRIBED`, so the existing reducer subscription is the *first* handler attached for that event; this `ctx.on("harness:start", ...)` adds a second handler. Both will fire — order is "registration order", and the reducer-side handler runs first so `state` is up to date if it ever uses harness-start data. The new handler does not depend on reducer side-effects of `harness:start`; it only registers adapters.

- [ ] **Step 5: Run the full suite to verify**

Run: `cd plugins/llm-status-items && bun test`
Expected: PASS — all existing tests plus the 3 new ones.

- [ ] **Step 6: Commit**

```bash
git add plugins/llm-status-items/index.ts plugins/llm-status-items/test/index.test.ts
git commit -m "feat(llm-status-items): register /status:show slash + status:show tool on harness:start"
```

---

## Task 5: Local deploy (rebuild bundled `dist/index.js`)

The Kaizen runtime prefers the bundled `dist/index.js` over source. Per `plugins/llm-status-items/CLAUDE.md`, the install dir must be re-bundled before changes take effect.

- [ ] **Step 1: Sync source into the install dir and rebuild the bundle**

Run:

```bash
cp -R plugins/llm-status-items/. ~/.kaizen/marketplaces/official/plugins/llm-status-items@0.1.0/
(cd ~/.kaizen/marketplaces/official/plugins/llm-status-items@0.1.0 \
  && bun build --target=bun --outfile=dist/index.js index.ts)
```

Expected: bundle written to `~/.kaizen/marketplaces/official/plugins/llm-status-items@0.1.0/dist/index.js` with no errors.

- [ ] **Step 2: Smoke-test by starting the harness and running `/status:show`**

Run a kaizen session as you normally would. In the TUI:

1. Type `/status:show` after the first turn completes.
2. Confirm the printed block matches the expected format (model, session, context window, totals, tok/s; cost line only if rate table is configured).
3. From the LLM side, prompt the assistant to call the `status:show` tool. Confirm it returns JSON matching the slash output's data.

- [ ] **Step 3: Mark TODO #2 done**

Edit `docs/TODO.md`: remove or strike item #2.

- [ ] **Step 4: Commit**

```bash
git add docs/TODO.md
git commit -m "chore: close TODO #2 — /status:show landed"
```

(No need to commit the install-dir changes; that directory is outside the repo.)

---

## Self-Review Notes

- **Spec coverage:** snapshot shape (Task 1), slash output rules including null-line omissions and tok/s formatting (Task 2), zero-arg tool returning JSON verbatim (Task 3), wiring with deferred soft consumption + parity (Task 4), local deploy (Task 5). Cost null when `!hasAnyRate` or model unpriced is enforced via `costActive` in Task 4 — same flag the existing `emitCost()` toggles.
- **Type consistency:** `StatusSnapshot` defined once in Task 1; all subsequent tasks import from `./snapshot.ts`. Slash + tool both consume `() => StatusSnapshot`. Adapter manifests are `source: "plugin"` (slash) and a vanilla `ToolSchema` (tool); both names are `"status:show"`.
- **No estimation:** spec compliance — `buildSnapshot` only reads existing `StatusState` fields and a real `costCents` accumulator. No tokenizer dependency added.
