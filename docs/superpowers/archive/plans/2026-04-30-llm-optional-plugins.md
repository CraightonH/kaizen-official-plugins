# LLM Optional Plugins Implementation Plan (`llm-status-items` + `llm-hooks-shell`)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Spec 12's two optional, opt-in C-tier add-ons: `llm-status-items` (status-bar visibility into model, tokens, turn-state, cost) and `llm-hooks-shell` (declarative shell-command hooks bound to harness events). Neither plugin registers a service; both are pure event consumers that consume `llm-events:vocabulary`.

**Architecture:** Two independent plugins, both following the `claude-status-items` pattern: a single `setup(ctx)` that consumes `llm-events:vocabulary`, subscribes to a fixed (or, for hooks-shell, config-derived) set of events, and reacts via `ctx.emit` (status items) or `ctx.exec.run` (shell hooks). Pure functions are factored into separate modules so they can be unit-tested without faking the harness.

**Tech Stack:** TypeScript, Bun runtime, native `node:fs/promises` and `node:path`. Tests use `bun:test`. No external runtime deps. The kaizen plugin contract types come from `kaizen/types`; shared LLM types come from `llm-events/public`.

---

## Scope: one plan, two plugins (NOT recommended to split)

This plan covers both plugins in one file. They are independent at runtime (no inter-dependency, no shared service contract beyond `llm-events:vocabulary`) and can be executed in parallel by separate subagents after Tier 0 finishes. Splitting would just duplicate the Tier 0 propagation step. If a future maintainer wants to ship them in separate releases, the marketplace task at the end (Task S6 / Task H8) is already split per-plugin.

A single Tier 0 task to `llm-events` is required because Spec 12 calls out the propagation rule: `llm-hooks-shell` needs a `CODEMODE_CANCEL_SENTINEL` string constant exported from `llm-events`. (The `tool:before-execute` cancel sentinel `CANCEL_TOOL` and the `llm:before-call` `request.cancelled` flag already exist per Spec 0; only codemode is missing.)

## Tier-for-Parallelism Map

- **Tier 0** (sequential, blocks all others): Task 0 (extend `llm-events` with `CODEMODE_CANCEL_SENTINEL`).
- **Tier 1A** (parallel — `llm-status-items`): Task S1–S6.
- **Tier 1B** (parallel — `llm-hooks-shell`): Task H1–H8.

`llm-status-items` and `llm-hooks-shell` may be implemented in parallel: they touch disjoint files, share no state, and only converge on the marketplace catalog (which is line-additive — easy merge).

## File Structure

```
plugins/llm-events/
  index.ts            # MODIFY: add CODEMODE_CANCEL_SENTINEL export
  public.d.ts         # MODIFY: declare CODEMODE_CANCEL_SENTINEL
  index.test.ts       # MODIFY: assert constant value

plugins/llm-status-items/
  index.ts            # plugin: setup, subscriptions, recompute() driver
  state.ts            # pure: TurnState, applyEvent(state, evtName, payload) → { state, emits[] }
  cost.ts             # pure: loadRateTable(deps), tokensToCents(rates, model, usage)
  package.json
  tsconfig.json
  README.md
  test/
    state.test.ts
    cost.test.ts
    index.test.ts
    fixtures/
      cost-table.json

plugins/llm-hooks-shell/
  index.ts            # plugin: setup → mergeConfigs → validate → subscribe → spawn
  config.ts           # pure: parse, merge, validate against VOCAB
  envify.ts           # pure: payload → EVENT_* env map (depth cap, JSON fallback)
  runner.ts           # spawn helper: ctx.exec.run + log routing + blocking semantics
  package.json
  tsconfig.json
  README.md
  test/
    config.test.ts
    envify.test.ts
    runner.test.ts
    index.test.ts
    fixtures/
      hooks.home.json
      hooks.project.json

.kaizen/marketplace.json   # MODIFY: append two plugin entries
```

Boundaries:
- `state.ts` is the pure turn-state machine for `llm-status-items` — no `ctx`, no I/O.
- `cost.ts` is the pure rate-table loader/multiplier — only its `deps.readFile` does I/O.
- `config.ts`, `envify.ts`, `runner.ts` (hooks-shell) are pure-ish; `runner.ts` takes `ctx.exec` and `ctx.log` as params so it tests with stubs.
- Plugin `index.ts` is the only file that reads `process.env`, `os.homedir()`, `process.cwd()` directly (and even those go through small dep facades for testability).

---

## Task 0: Extend `llm-events` with `CODEMODE_CANCEL_SENTINEL` (Tier 0)

**Files:**
- Modify: `plugins/llm-events/index.ts`
- Modify: `plugins/llm-events/public.d.ts`
- Modify: `plugins/llm-events/index.test.ts`

Spec 12 requires this constant to exist in `llm-events` before `llm-hooks-shell` can implement `block_on_nonzero` for `codemode:before-execute`. Spec 0 already pins `CANCEL_TOOL = Symbol.for("kaizen.cancel")` for tools and `request.cancelled = true` for `llm:before-call`; only codemode is unpinned. Since `codemode:before-execute`'s payload is `{ code: string }`, a Symbol cannot live inside a string field — we use a well-known string literal instead.

- [ ] **Step 1: Add the failing test**

Edit `plugins/llm-events/index.test.ts`. Add this `it` block inside the existing `describe("llm-events", ...)`:

```ts
  it("CODEMODE_CANCEL_SENTINEL is the well-known string", async () => {
    const mod = await import("./index.ts");
    expect(mod.CODEMODE_CANCEL_SENTINEL).toBe("__kaizen_cancel__");
  });
```

- [ ] **Step 2: Run test to verify failure**

Run: `bun test plugins/llm-events/`
Expected: FAIL — `CODEMODE_CANCEL_SENTINEL` is undefined.

- [ ] **Step 3: Declare the constant in `public.d.ts`**

Append to `plugins/llm-events/public.d.ts`:

```ts
/**
 * Cancellation sentinel for `codemode:before-execute` subscribers. Set
 * `event.code = CODEMODE_CANCEL_SENTINEL` to abort code execution. The
 * codemode runner surfaces a cancelled execution as a `codemode:error`
 * with message `"cancelled"`.
 */
export declare const CODEMODE_CANCEL_SENTINEL: "__kaizen_cancel__";
```

- [ ] **Step 4: Export the constant from `index.ts`**

Append to `plugins/llm-events/index.ts` (near the existing `export const CANCEL_TOOL`):

```ts
export const CODEMODE_CANCEL_SENTINEL = "__kaizen_cancel__" as const;
```

- [ ] **Step 5: Run tests**

Run: `bun test plugins/llm-events/`
Expected: PASS — all existing tests plus the new one (6 tests total).

- [ ] **Step 6: Bump `llm-events` patch version**

Edit `plugins/llm-events/package.json`: change `"version": "0.1.0"` → `"version": "0.2.0"`.

- [ ] **Step 7: Commit**

```bash
git add plugins/llm-events/index.ts plugins/llm-events/public.d.ts plugins/llm-events/index.test.ts plugins/llm-events/package.json
git commit -m "feat(llm-events): add CODEMODE_CANCEL_SENTINEL for hook-driven codemode cancellation"
```

---

# Plugin 1 — `llm-status-items`

## Task S1: Scaffold `llm-status-items` package

**Files:**
- Create: `plugins/llm-status-items/package.json`
- Create: `plugins/llm-status-items/tsconfig.json`
- Create: `plugins/llm-status-items/README.md`
- Create: `plugins/llm-status-items/index.ts` (placeholder)

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "llm-status-items",
  "version": "0.1.0",
  "description": "Status-bar items (model, tokens, turn-state, optional cost) for the openai-compatible harness.",
  "type": "module",
  "exports": { ".": "./index.ts" },
  "keywords": ["kaizen-plugin"],
  "dependencies": {
    "llm-events": "workspace:*"
  },
  "devDependencies": {
    "@types/bun": "latest",
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
  name: "llm-status-items",
  apiVersion: "3.0.0",
  permissions: { tier: "trusted" },
  services: { consumes: ["llm-events:vocabulary"] },
  async setup(ctx) {
    // Filled in by Task S5.
    ctx.consumeService("llm-events:vocabulary");
  },
};

export default plugin;
```

- [ ] **Step 4: Write `README.md`**

```markdown
# llm-status-items

Optional status-bar plugin for the openai-compatible harness. Surfaces four
items: `model`, `tokens`, `turn-state`, and (if a rate table is provided)
`cost-estimate`.

## Do you want this?

Add it if you want at-a-glance visibility into which model is in use, how many
tokens have been spent this session, and whether the agent is thinking, calling
a tool, or idle. Skip it if you prefer a quiet status bar — none of the events
or services in this plugin affect chat, tools, agents, or memory.

## Configuration

Drop a `~/.kaizen/plugins/llm-status-items/cost-table.json` file to enable cost:

\`\`\`json
{
  "rates": {
    "gpt-4.1-mini": { "promptCentsPerMTok": 15,  "completionCentsPerMTok": 60 },
    "gpt-4.1":      { "promptCentsPerMTok": 200, "completionCentsPerMTok": 800 }
  }
}
\`\`\`

If a model is absent from the table, no `cost-estimate` is emitted (and any
prior value is cleared) — better than displaying a misleading `$0.0000`.
```

- [ ] **Step 5: Refresh workspace install**

Run: `bun install`
Expected: workspace resolves `llm-status-items`; no errors.

- [ ] **Step 6: Commit**

```bash
git add plugins/llm-status-items/
git commit -m "feat(llm-status-items): scaffold package skeleton"
```

---

## Task S2: `state.ts` — pure turn-state machine

**Files:**
- Create: `plugins/llm-status-items/state.ts`
- Create: `plugins/llm-status-items/test/state.test.ts`

The state machine is fed event names + payloads and yields the current `turn-state` label and accumulated token totals. It is pure — no `ctx`, no I/O. The plugin's `setup` calls `applyEvent` on each subscribed event and emits `status:item-update`/`status:item-clear` based on the diff against the previous state.

- [ ] **Step 1: Write the failing tests**

Create `plugins/llm-status-items/test/state.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { initialState, applyEvent, type StatusState } from "../state.ts";

function step(s: StatusState, name: string, payload: any = {}): StatusState {
  return applyEvent(s, name, payload);
}

describe("applyEvent", () => {
  it("turn:start sets turn-state to thinking", () => {
    const s = step(initialState(), "turn:start", { turnId: "t-1" });
    expect(s.turnState).toBe("thinking");
    expect(s.turnInFlight).toBe(true);
  });

  it("tool:before-execute sets turn-state to calling <name>", () => {
    let s = step(initialState(), "turn:start", { turnId: "t-1" });
    s = step(s, "tool:before-execute", { name: "bash", args: {}, callId: "c1" });
    expect(s.turnState).toBe("calling bash");
    expect(s.currentTool).toBe("bash");
  });

  it("tool:result returns to thinking", () => {
    let s = step(initialState(), "turn:start", {});
    s = step(s, "tool:before-execute", { name: "bash", args: {}, callId: "c1" });
    s = step(s, "tool:result", { callId: "c1", result: "ok" });
    expect(s.turnState).toBe("thinking");
    expect(s.currentTool).toBeNull();
  });

  it("tool:error returns to thinking", () => {
    let s = step(initialState(), "turn:start", {});
    s = step(s, "tool:before-execute", { name: "bash", args: {}, callId: "c1" });
    s = step(s, "tool:error", { callId: "c1", message: "boom" });
    expect(s.turnState).toBe("thinking");
    expect(s.currentTool).toBeNull();
  });

  it("turn:end sets turn-state to ready", () => {
    let s = step(initialState(), "turn:start", {});
    s = step(s, "turn:end", { turnId: "t-1", reason: "complete" });
    expect(s.turnState).toBe("ready");
    expect(s.turnInFlight).toBe(false);
  });

  it("llm:before-call updates the active model", () => {
    const s = step(initialState(), "llm:before-call", {
      request: { model: "gpt-4.1-mini", messages: [] },
    });
    expect(s.model).toBe("gpt-4.1-mini");
  });

  it("llm:before-call respects upstream subscriber mutation", () => {
    // Memory-injection plugin would have already mutated request.model.
    const s = step(initialState(), "llm:before-call", {
      request: { model: "gpt-4.1", messages: [] },
    });
    expect(s.model).toBe("gpt-4.1");
  });

  it("llm:before-call is idempotent for turnState=thinking", () => {
    let s = step(initialState(), "turn:start", {});
    s = step(s, "llm:before-call", { request: { model: "x", messages: [] } });
    expect(s.turnState).toBe("thinking");
  });

  it("llm:done accumulates tokens", () => {
    let s = step(initialState(), "llm:done", {
      response: { content: "", finishReason: "stop", usage: { promptTokens: 100, completionTokens: 50 } },
    });
    expect(s.promptTokens).toBe(100);
    expect(s.completionTokens).toBe(50);
    s = step(s, "llm:done", {
      response: { content: "", finishReason: "stop", usage: { promptTokens: 300, completionTokens: 150 } },
    });
    expect(s.promptTokens).toBe(400);
    expect(s.completionTokens).toBe(200);
  });

  it("llm:done without usage leaves token totals unchanged", () => {
    let s = step(initialState(), "llm:done", {
      response: { content: "", finishReason: "stop", usage: { promptTokens: 10, completionTokens: 5 } },
    });
    s = step(s, "llm:done", { response: { content: "", finishReason: "stop" } });
    expect(s.promptTokens).toBe(10);
    expect(s.completionTokens).toBe(5);
  });

  it("conversation:cleared zeros tokens and clears model+cost markers", () => {
    let s = step(initialState(), "llm:done", {
      response: { content: "", finishReason: "stop", usage: { promptTokens: 100, completionTokens: 50 } },
    });
    s = step(s, "conversation:cleared", {});
    expect(s.promptTokens).toBe(0);
    expect(s.completionTokens).toBe(0);
    expect(s.cleared).toBe(true);
  });

  it("llm:done with no further tool calls and ended turn → ready", () => {
    let s = step(initialState(), "turn:start", {});
    s = step(s, "llm:done", { response: { content: "ok", finishReason: "stop" } });
    s = step(s, "turn:end", { turnId: "t-1", reason: "complete" });
    expect(s.turnState).toBe("ready");
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `bun test plugins/llm-status-items/test/state.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `state.ts`**

```ts
export interface StatusState {
  model: string | null;
  promptTokens: number;
  completionTokens: number;
  turnInFlight: boolean;
  currentTool: string | null;
  turnState: "ready" | "thinking" | string; // also "calling <tool>"
  cleared: boolean; // one-shot flag — driver clears after emitting status:item-clear
}

export function initialState(): StatusState {
  return {
    model: null,
    promptTokens: 0,
    completionTokens: 0,
    turnInFlight: false,
    currentTool: null,
    turnState: "ready",
    cleared: false,
  };
}

function recompute(s: StatusState): StatusState {
  if (s.currentTool) {
    return { ...s, turnState: `calling ${s.currentTool}` };
  }
  if (s.turnInFlight) {
    return { ...s, turnState: "thinking" };
  }
  return { ...s, turnState: "ready" };
}

export function applyEvent(prev: StatusState, name: string, payload: any): StatusState {
  // Always reset the one-shot cleared flag at the top of each event.
  let s: StatusState = { ...prev, cleared: false };

  switch (name) {
    case "turn:start":
      s.turnInFlight = true;
      s.currentTool = null;
      return recompute(s);

    case "llm:before-call": {
      const model = payload?.request?.model;
      if (typeof model === "string" && model.length > 0) s.model = model;
      // Do not flip turnInFlight — turn:start owns that. Recompute is idempotent.
      return recompute(s);
    }

    case "tool:before-execute": {
      const name = typeof payload?.name === "string" ? payload.name : "tool";
      s.currentTool = name;
      return recompute(s);
    }

    case "tool:result":
    case "tool:error":
      s.currentTool = null;
      return recompute(s);

    case "llm:done": {
      const usage = payload?.response?.usage;
      if (usage && typeof usage.promptTokens === "number" && typeof usage.completionTokens === "number") {
        s.promptTokens += usage.promptTokens;
        s.completionTokens += usage.completionTokens;
      }
      // Do NOT flip turnInFlight here — turn:end is the authoritative end signal.
      return recompute(s);
    }

    case "turn:end":
      s.turnInFlight = false;
      s.currentTool = null;
      return recompute(s);

    case "conversation:cleared":
      s.promptTokens = 0;
      s.completionTokens = 0;
      s.cleared = true;
      return recompute(s);

    default:
      return prev; // no-op for events we do not handle
  }
}
```

- [ ] **Step 4: Run tests**

Run: `bun test plugins/llm-status-items/test/state.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-status-items/state.ts plugins/llm-status-items/test/state.test.ts
git commit -m "feat(llm-status-items): pure turn-state machine and token accumulator"
```

---

## Task S3: `cost.ts` — rate-table loader and cost computation

**Files:**
- Create: `plugins/llm-status-items/cost.ts`
- Create: `plugins/llm-status-items/test/cost.test.ts`
- Create: `plugins/llm-status-items/test/fixtures/cost-table.json`

Pure functions:
- `loadRateTable(deps)` — reads JSON; missing file returns `{}`; malformed JSON throws with a clear message.
- `tokensToCents(rates, model, usage)` — returns `null` when model is absent (so caller knows to clear), otherwise returns the cents (number) for the increment.
- `formatDollars(cents)` — `12345 / 100` → `"$123.4500"` style. 4 decimals.

- [ ] **Step 1: Write the fixture**

Create `plugins/llm-status-items/test/fixtures/cost-table.json`:

```json
{
  "rates": {
    "gpt-4.1-mini": { "promptCentsPerMTok": 15, "completionCentsPerMTok": 60 },
    "gpt-4.1":      { "promptCentsPerMTok": 200, "completionCentsPerMTok": 800 }
  }
}
```

- [ ] **Step 2: Write the failing tests**

Create `plugins/llm-status-items/test/cost.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadRateTable, tokensToCents, formatDollars, type CostDeps } from "../cost.ts";

const FIXTURE = resolve(import.meta.dir, "fixtures/cost-table.json");

function makeDeps(overrides: Partial<CostDeps> = {}): CostDeps {
  return {
    home: "/home/u",
    readFile: async () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); },
    ...overrides,
  };
}

describe("loadRateTable", () => {
  it("returns empty rates when file is absent", async () => {
    const t = await loadRateTable(makeDeps());
    expect(t).toEqual({});
  });

  it("loads rates from a real file", async () => {
    const t = await loadRateTable(makeDeps({ readFile: () => readFile(FIXTURE, "utf8") }));
    expect(t["gpt-4.1-mini"]).toEqual({ promptCentsPerMTok: 15, completionCentsPerMTok: 60 });
    expect(t["gpt-4.1"]).toEqual({ promptCentsPerMTok: 200, completionCentsPerMTok: 800 });
  });

  it("throws on malformed JSON", async () => {
    await expect(
      loadRateTable(makeDeps({ readFile: async () => "{not-json" })),
    ).rejects.toThrow(/llm-status-items.*cost-table.*malformed/i);
  });

  it("uses ~/.kaizen/plugins/llm-status-items/cost-table.json by default", async () => {
    let path = "";
    await loadRateTable(makeDeps({
      readFile: async (p: string) => { path = p; return JSON.stringify({ rates: {} }); },
    }));
    expect(path).toBe("/home/u/.kaizen/plugins/llm-status-items/cost-table.json");
  });
});

describe("tokensToCents", () => {
  const rates = {
    "gpt-4.1-mini": { promptCentsPerMTok: 15, completionCentsPerMTok: 60 },
  };

  it("returns null when model is missing", () => {
    expect(tokensToCents(rates, "unknown-model", { promptTokens: 100, completionTokens: 50 })).toBeNull();
  });

  it("computes cents for known model", () => {
    // 1_000_000 prompt @ 15 cents = 15 cents; 1_000_000 completion @ 60 cents = 60 cents
    expect(tokensToCents(rates, "gpt-4.1-mini", { promptTokens: 1_000_000, completionTokens: 1_000_000 })).toBeCloseTo(75, 6);
  });

  it("scales linearly", () => {
    expect(tokensToCents(rates, "gpt-4.1-mini", { promptTokens: 100, completionTokens: 50 })).toBeCloseTo(
      (100 * 15 + 50 * 60) / 1_000_000, 9,
    );
  });
});

describe("formatDollars", () => {
  it("formats cents with 4 decimal places", () => {
    expect(formatDollars(0)).toBe("$0.0000");
    expect(formatDollars(1.23)).toBe("$0.0123");
    expect(formatDollars(12345)).toBe("$123.4500");
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `bun test plugins/llm-status-items/test/cost.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `cost.ts`**

```ts
import { readFile as fsReadFile } from "node:fs/promises";
import { homedir } from "node:os";

export interface RateEntry {
  promptCentsPerMTok: number;
  completionCentsPerMTok: number;
}
export type RateTable = Record<string, RateEntry>;

export interface CostDeps {
  home: string;
  readFile: (path: string) => Promise<string>;
}

export function realCostDeps(): CostDeps {
  return {
    home: homedir(),
    readFile: (p) => fsReadFile(p, "utf8"),
  };
}

const RATE_FILE_REL = ".kaizen/plugins/llm-status-items/cost-table.json";

export async function loadRateTable(deps: CostDeps): Promise<RateTable> {
  const path = `${deps.home}/${RATE_FILE_REL}`;
  let text: string;
  try {
    text = await deps.readFile(path);
  } catch (e: any) {
    if (e?.code === "ENOENT") return {};
    throw e;
  }
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`llm-status-items: cost-table at ${path} is malformed JSON: ${(e as Error).message}`);
  }
  const rates = parsed?.rates;
  if (rates && typeof rates === "object") return rates as RateTable;
  return {};
}

export function tokensToCents(
  rates: RateTable,
  model: string,
  usage: { promptTokens: number; completionTokens: number },
): number | null {
  const r = rates[model];
  if (!r) return null;
  return (usage.promptTokens * r.promptCentsPerMTok + usage.completionTokens * r.completionCentsPerMTok) / 1_000_000;
}

export function formatDollars(cents: number): string {
  const dollars = cents / 100;
  // 4 decimals per spec.
  return `$${dollars.toFixed(4)}`;
}
```

- [ ] **Step 5: Run tests**

Run: `bun test plugins/llm-status-items/test/cost.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Commit**

```bash
git add plugins/llm-status-items/cost.ts plugins/llm-status-items/test/cost.test.ts plugins/llm-status-items/test/fixtures/
git commit -m "feat(llm-status-items): rate-table loader, cost math, dollar formatter"
```

---

## Task S4: `index.ts` — wire setup, subscribe to 8 events, emit status items

**Files:**
- Modify: `plugins/llm-status-items/index.ts`
- Create: `plugins/llm-status-items/test/index.test.ts`

The plugin keeps a mutable `StatusState` plus a running `costCents`. On each subscribed event it calls `applyEvent`, then diffs against the previous emit to decide which `status:item-update`/`status:item-clear` calls to make. The four logical items use stable keys: `model`, `tokens`, `turn-state`, `cost-estimate`.

- [ ] **Step 1: Write the failing test**

Create `plugins/llm-status-items/test/index.test.ts`:

```ts
import { describe, it, expect, mock } from "bun:test";
import plugin from "../index.ts";

interface Emit { event: string; payload: any }

function makeCtx(opts: { rateTable?: Record<string, any> } = {}) {
  const subscribed: string[] = [];
  const handlers: Record<string, (p: any) => void | Promise<void>> = {};
  const emits: Emit[] = [];
  return {
    subscribed,
    handlers,
    emits,
    log: mock(() => {}),
    config: {},
    defineEvent: mock(() => {}),
    on: mock((name: string, fn: (p: any) => void) => { subscribed.push(name); handlers[name] = fn; }),
    emit: mock(async (event: string, payload: any) => { emits.push({ event, payload }); return []; }),
    defineService: mock(() => {}),
    provideService: mock(() => {}),
    consumeService: mock(() => {}),
    useService: mock(() => undefined),
    secrets: { get: mock(async () => undefined), refresh: mock(async () => undefined) },
    // Internal facades the plugin reads — see Step 2 implementation.
    _testCostDeps: {
      home: "/home/u",
      readFile: async () => JSON.stringify({ rates: opts.rateTable ?? {} }),
    },
  } as any;
}

describe("llm-status-items setup", () => {
  it("subscribes to exactly the 8 spec'd events", async () => {
    const ctx = makeCtx();
    await plugin.setup(ctx);
    expect(ctx.subscribed.sort()).toEqual([
      "conversation:cleared",
      "llm:before-call",
      "llm:done",
      "tool:before-execute",
      "tool:error",
      "tool:result",
      "turn:end",
      "turn:start",
    ]);
  });

  it("emits status:item-update for model on llm:before-call", async () => {
    const ctx = makeCtx();
    await plugin.setup(ctx);
    await ctx.handlers["llm:before-call"]!({ request: { model: "gpt-4.1-mini", messages: [] } });
    const modelEmit = ctx.emits.find((e: Emit) => e.event === "status:item-update" && e.payload?.key === "model");
    expect(modelEmit?.payload.value).toBe("gpt-4.1-mini");
  });

  it("accumulates tokens across two llm:done events", async () => {
    const ctx = makeCtx();
    await plugin.setup(ctx);
    await ctx.handlers["llm:done"]!({ response: { content: "", finishReason: "stop", usage: { promptTokens: 100, completionTokens: 50 } } });
    await ctx.handlers["llm:done"]!({ response: { content: "", finishReason: "stop", usage: { promptTokens: 300, completionTokens: 150 } } });
    const last = [...ctx.emits].reverse().find((e: Emit) => e.event === "status:item-update" && e.payload?.key === "tokens");
    expect(last?.payload.value).toBe("400+200 = 600");
  });

  it("conversation:cleared emits status:item-clear for tokens (and cost-estimate if active)", async () => {
    const ctx = makeCtx({ rateTable: { "gpt-4.1-mini": { promptCentsPerMTok: 15, completionCentsPerMTok: 60 } } });
    await plugin.setup(ctx);
    await ctx.handlers["llm:before-call"]!({ request: { model: "gpt-4.1-mini", messages: [] } });
    await ctx.handlers["llm:done"]!({ response: { content: "", finishReason: "stop", usage: { promptTokens: 100, completionTokens: 50 } } });
    await ctx.handlers["conversation:cleared"]!({});
    const clears = ctx.emits.filter((e: Emit) => e.event === "status:item-clear").map((e: Emit) => e.payload.key);
    expect(clears).toContain("tokens");
    expect(clears).toContain("cost-estimate");
  });

  it("turn-state transitions: thinking → calling bash → thinking → ready", async () => {
    const ctx = makeCtx();
    await plugin.setup(ctx);
    await ctx.handlers["turn:start"]!({ turnId: "t-1" });
    await ctx.handlers["tool:before-execute"]!({ name: "bash", args: {}, callId: "c1" });
    await ctx.handlers["tool:result"]!({ callId: "c1", result: "ok" });
    await ctx.handlers["turn:end"]!({ turnId: "t-1", reason: "complete" });
    const turnStateValues = ctx.emits
      .filter((e: Emit) => e.event === "status:item-update" && e.payload?.key === "turn-state")
      .map((e: Emit) => e.payload.value);
    expect(turnStateValues).toEqual(["thinking", "calling bash", "thinking", "ready"]);
  });

  it("cost: with rate table, two llm:done emits the formatted dollar string", async () => {
    const ctx = makeCtx({
      rateTable: { "gpt-4.1-mini": { promptCentsPerMTok: 15, completionCentsPerMTok: 60 } },
    });
    await plugin.setup(ctx);
    await ctx.handlers["llm:before-call"]!({ request: { model: "gpt-4.1-mini", messages: [] } });
    await ctx.handlers["llm:done"]!({ response: { content: "", finishReason: "stop", usage: { promptTokens: 1_000_000, completionTokens: 1_000_000 } } });
    await ctx.handlers["llm:done"]!({ response: { content: "", finishReason: "stop", usage: { promptTokens: 1_000_000, completionTokens: 1_000_000 } } });
    const last = [...ctx.emits].reverse().find((e: Emit) => e.event === "status:item-update" && e.payload?.key === "cost-estimate");
    // 2 * (15 + 60) cents = 150 cents = $1.5000
    expect(last?.payload.value).toBe("$1.5000");
  });

  it("cost: model absent from rate table → no cost-estimate update; prior value cleared", async () => {
    const ctx = makeCtx({ rateTable: { "gpt-4.1": { promptCentsPerMTok: 200, completionCentsPerMTok: 800 } } });
    await plugin.setup(ctx);
    // Switch to a known model first to seed a prior value.
    await ctx.handlers["llm:before-call"]!({ request: { model: "gpt-4.1", messages: [] } });
    await ctx.handlers["llm:done"]!({ response: { content: "", finishReason: "stop", usage: { promptTokens: 100, completionTokens: 50 } } });
    // Now switch to an unknown model.
    await ctx.handlers["llm:before-call"]!({ request: { model: "unknown-model", messages: [] } });
    await ctx.handlers["llm:done"]!({ response: { content: "", finishReason: "stop", usage: { promptTokens: 100, completionTokens: 50 } } });
    const lastClearOrUpdate = [...ctx.emits].reverse().find(
      (e: Emit) => (e.event === "status:item-update" || e.event === "status:item-clear") && e.payload?.key === "cost-estimate",
    );
    expect(lastClearOrUpdate?.event).toBe("status:item-clear");
  });

  it("model value reflects post-mutation request (memory-injection scenario)", async () => {
    const ctx = makeCtx();
    await plugin.setup(ctx);
    // Pretend an upstream subscriber already mutated request.model.
    await ctx.handlers["llm:before-call"]!({ request: { model: "memory-injected-model", messages: [] } });
    const modelEmit = ctx.emits.find((e: Emit) => e.event === "status:item-update" && e.payload?.key === "model");
    expect(modelEmit?.payload.value).toBe("memory-injected-model");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test plugins/llm-status-items/test/index.test.ts`
Expected: FAIL — current placeholder `index.ts` does no work.

- [ ] **Step 3: Implement `index.ts`**

Replace `plugins/llm-status-items/index.ts`:

```ts
import type { KaizenPlugin } from "kaizen/types";
import { applyEvent, initialState, type StatusState } from "./state.ts";
import { formatDollars, loadRateTable, realCostDeps, tokensToCents, type CostDeps, type RateTable } from "./cost.ts";

const SUBSCRIBED = [
  "llm:before-call",
  "llm:done",
  "turn:start",
  "turn:end",
  "tool:before-execute",
  "tool:result",
  "tool:error",
  "conversation:cleared",
] as const;

const plugin: KaizenPlugin = {
  name: "llm-status-items",
  apiVersion: "3.0.0",
  permissions: {
    tier: "trusted",
    events: { subscribe: [...SUBSCRIBED] },
  },
  services: { consumes: ["llm-events:vocabulary"] },

  async setup(ctx) {
    ctx.consumeService("llm-events:vocabulary");

    // Cost deps come from a private test hook on ctx, falling back to the real fs.
    // (`_testCostDeps` is only set by tests; production code never reads it.)
    const costDeps: CostDeps = (ctx as any)._testCostDeps ?? realCostDeps();
    const rates: RateTable = await loadRateTable(costDeps);
    const hasAnyRate = Object.keys(rates).length > 0;

    let state: StatusState = initialState();
    let costCents = 0;
    let costActive = false; // becomes true after first successful cost emission; controls whether to clear on conversation:cleared

    let lastEmitted = {
      model: null as string | null,
      tokens: null as string | null,
      turnState: null as string | null,
      cost: null as string | null,
    };

    async function emitDiff() {
      // model
      if (state.model && state.model !== lastEmitted.model) {
        await ctx.emit("status:item-update", { key: "model", value: state.model });
        lastEmitted.model = state.model;
      }
      // tokens
      const total = state.promptTokens + state.completionTokens;
      const tokensValue = `${state.promptTokens}+${state.completionTokens} = ${total}`;
      if (state.cleared && lastEmitted.tokens !== null) {
        await ctx.emit("status:item-clear", { key: "tokens" });
        lastEmitted.tokens = null;
      } else if (!state.cleared && tokensValue !== lastEmitted.tokens && (state.promptTokens > 0 || state.completionTokens > 0)) {
        await ctx.emit("status:item-update", { key: "tokens", value: tokensValue });
        lastEmitted.tokens = tokensValue;
      }
      // turn-state
      if (state.turnState !== lastEmitted.turnState) {
        await ctx.emit("status:item-update", { key: "turn-state", value: state.turnState });
        lastEmitted.turnState = state.turnState;
      }
    }

    async function emitCost(eventName: string, payload: any) {
      if (!hasAnyRate) return; // fully local — never emit cost-estimate
      if (eventName === "conversation:cleared") {
        costCents = 0;
        if (costActive) {
          await ctx.emit("status:item-clear", { key: "cost-estimate" });
          lastEmitted.cost = null;
          costActive = false;
        }
        return;
      }
      if (eventName !== "llm:done") return;
      const usage = payload?.response?.usage;
      if (!usage || !state.model) return;
      const inc = tokensToCents(rates, state.model, usage);
      if (inc === null) {
        // Model not in table — clear any prior cost-estimate.
        if (costActive) {
          await ctx.emit("status:item-clear", { key: "cost-estimate" });
          lastEmitted.cost = null;
          costActive = false;
        }
        return;
      }
      costCents += inc;
      const display = formatDollars(costCents);
      if (display !== lastEmitted.cost) {
        await ctx.emit("status:item-update", { key: "cost-estimate", value: display });
        lastEmitted.cost = display;
        costActive = true;
      }
    }

    for (const name of SUBSCRIBED) {
      ctx.on(name, async (payload: any) => {
        state = applyEvent(state, name, payload);
        await emitDiff();
        await emitCost(name, payload);
      });
    }
  },
};

export default plugin;
```

- [ ] **Step 4: Run tests**

Run: `bun test plugins/llm-status-items/`
Expected: PASS, all status-items tests (state + cost + index = 28 tests).

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-status-items/index.ts plugins/llm-status-items/test/index.test.ts
git commit -m "feat(llm-status-items): wire setup, 8 subscriptions, status:item-update/clear emission"
```

---

## Task S5: Marketplace catalog — register `llm-status-items`

**Files:**
- Modify: `.kaizen/marketplace.json`

- [ ] **Step 1: Edit `.kaizen/marketplace.json`**

Append the following object to the `entries` array (right before the harness entry):

```json
{
  "kind": "plugin",
  "name": "llm-status-items",
  "description": "Optional status-bar items (model, tokens, turn-state, optional cost) for the openai-compatible harness.",
  "categories": ["status", "llm"],
  "versions": [{ "version": "0.1.0", "source": { "type": "file", "path": "plugins/llm-status-items" } }]
}
```

- [ ] **Step 2: Verify JSON is valid**

Run: `bun -e "JSON.parse(await Bun.file('.kaizen/marketplace.json').text()); console.log('ok')"`
Expected: prints `ok`.

- [ ] **Step 3: Commit**

```bash
git add .kaizen/marketplace.json
git commit -m "chore(marketplace): publish llm-status-items@0.1.0"
```

---

# Plugin 2 — `llm-hooks-shell`

## Task H1: Scaffold `llm-hooks-shell` package

**Files:**
- Create: `plugins/llm-hooks-shell/package.json`
- Create: `plugins/llm-hooks-shell/tsconfig.json`
- Create: `plugins/llm-hooks-shell/README.md`
- Create: `plugins/llm-hooks-shell/index.ts` (placeholder)

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "llm-hooks-shell",
  "version": "0.1.0",
  "description": "Declarative shell-command hooks bound to harness events. Optional, opt-in.",
  "type": "module",
  "exports": { ".": "./index.ts" },
  "keywords": ["kaizen-plugin"],
  "dependencies": {
    "llm-events": "workspace:*"
  },
  "devDependencies": {
    "@types/bun": "latest",
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
  name: "llm-hooks-shell",
  apiVersion: "3.0.0",
  permissions: { tier: "unscoped", exec: { binaries: ["sh"] } },
  services: { consumes: ["llm-events:vocabulary"] },
  async setup(ctx) {
    // Filled in by Task H6.
    ctx.consumeService("llm-events:vocabulary");
  },
};

export default plugin;
```

- [ ] **Step 4: Write `README.md`**

```markdown
# llm-hooks-shell

Optional shell-command hooks for the openai-compatible harness. Reads
`~/.kaizen/hooks/hooks.json` and `<cwd>/.kaizen/hooks/hooks.json`, subscribes
to the named events, and runs the configured `sh -c` command when each fires.

## Do you want this?

Add it if you want declarative hooks for audit, notifications, or blocking
gates on tool/codemode/llm calls. Skip it if you don't already know what you'd
hook — there's no built-in default.

## Security warning

This plugin runs arbitrary shell commands with the harness's privileges. The
permission tier is `unscoped` for that reason. Do NOT check
`hooks.json` into a shared repo without review — a malicious hook could
exfiltrate secrets or destroy data.

## Schema

\`\`\`json
{
  "hooks": [
    { "event": "turn:start", "command": "echo $EVENT_TURN_ID >> /tmp/audit.log" },
    { "event": "tool:before-execute", "command": "./check-tool.sh", "block_on_nonzero": true, "timeout_ms": 5000 },
    { "event": "turn:end", "command": "osascript -e 'display notification \"done\"'" }
  ]
}
\`\`\`

Hook entries support `event`, `command`, optional `cwd`, optional
`block_on_nonzero` (only meaningful for mutable events: `tool:before-execute`,
`codemode:before-execute`), optional `timeout_ms` (default 30s), and optional
`env` (merged on top of the `EVENT_*` set).

## Event payload as environment

Top-level scalar keys become `EVENT_<UPPER_SNAKE>`. Objects/arrays are
JSON-encoded into the same key AND recursively flattened up to depth 4.
`EVENT_NAME` is always set to the event name; `EVENT_JSON` is always the
full payload as JSON. camelCase keys convert to UPPER_SNAKE
(`turnId` → `EVENT_TURN_ID`).

## Differences from Claude Code's hooks

- v1 keys on event name only (no `tool_name` or regex matchers).
- Exit code is the only signal — stdout is logged but not parsed for payload mutation.
- Multiple hooks for the same event run sequentially in config order
  (home file before project file).
```

- [ ] **Step 5: Refresh workspace install**

Run: `bun install`
Expected: workspace resolves `llm-hooks-shell`; no errors.

- [ ] **Step 6: Commit**

```bash
git add plugins/llm-hooks-shell/
git commit -m "feat(llm-hooks-shell): scaffold package skeleton"
```

---

## Task H2: `config.ts` — parse, merge, validate hook config

**Files:**
- Create: `plugins/llm-hooks-shell/config.ts`
- Create: `plugins/llm-hooks-shell/test/config.test.ts`
- Create: `plugins/llm-hooks-shell/test/fixtures/hooks.home.json`
- Create: `plugins/llm-hooks-shell/test/fixtures/hooks.project.json`

`loadHookConfigs(deps, vocab)` reads both files (missing → empty), merges as `[...home, ...project]` (home first), validates each entry against `vocab` (set of valid event names), and returns the array. Malformed JSON throws. Unknown event names throw. `block_on_nonzero` on `llm:before-call` throws (per Spec 12: until Spec 0 specifies the cancellation mechanism — but Spec 0 already specifies `request.cancelled = true`, so this rule is RELAXED: `block_on_nonzero` on `llm:before-call` is supported. We retain the validation for any non-mutable event with `block_on_nonzero` setting → warning, not throw — collected in a `warnings: string[]` field of the return value).

Mutable events (per Spec 0): `llm:before-call`, `tool:before-execute`, `codemode:before-execute`. All three support `block_on_nonzero`. Non-mutable events with `block_on_nonzero: true` are kept but accompanied by a warning string.

- [ ] **Step 1: Write fixtures**

`plugins/llm-hooks-shell/test/fixtures/hooks.home.json`:

```json
{
  "hooks": [
    { "event": "turn:start", "command": "echo home >> /tmp/audit.log" }
  ]
}
```

`plugins/llm-hooks-shell/test/fixtures/hooks.project.json`:

```json
{
  "hooks": [
    { "event": "tool:before-execute", "command": "./check-tool.sh", "block_on_nonzero": true, "timeout_ms": 5000 }
  ]
}
```

- [ ] **Step 2: Write the failing tests**

Create `plugins/llm-hooks-shell/test/config.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadHookConfigs, type ConfigDeps, MUTABLE_EVENTS } from "../config.ts";

const VOCAB = new Set([
  "turn:start", "turn:end", "llm:before-call", "tool:before-execute",
  "codemode:before-execute", "tool:result", "llm:done",
]);

const HOME_FIXTURE = resolve(import.meta.dir, "fixtures/hooks.home.json");
const PROJECT_FIXTURE = resolve(import.meta.dir, "fixtures/hooks.project.json");

function makeDeps(overrides: Partial<ConfigDeps> = {}): ConfigDeps {
  return {
    home: "/home/u",
    cwd: "/work/proj",
    readFile: async () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); },
    ...overrides,
  };
}

describe("loadHookConfigs", () => {
  it("returns empty list when neither file exists", async () => {
    const r = await loadHookConfigs(makeDeps(), VOCAB);
    expect(r.entries).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it("loads home-only config", async () => {
    const r = await loadHookConfigs(makeDeps({
      readFile: async (p) => p.startsWith("/home/u/")
        ? readFile(HOME_FIXTURE, "utf8")
        : Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
    }), VOCAB);
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]!.event).toBe("turn:start");
  });

  it("merges home + project in home-first order", async () => {
    const r = await loadHookConfigs(makeDeps({
      readFile: async (p) => p.startsWith("/home/u/")
        ? readFile(HOME_FIXTURE, "utf8")
        : readFile(PROJECT_FIXTURE, "utf8"),
    }), VOCAB);
    expect(r.entries.map(e => e.event)).toEqual(["turn:start", "tool:before-execute"]);
  });

  it("throws on malformed JSON", async () => {
    await expect(loadHookConfigs(makeDeps({
      readFile: async () => "{not-json",
    }), VOCAB)).rejects.toThrow(/llm-hooks-shell.*malformed/i);
  });

  it("throws on unknown event name and surfaces the offending entry", async () => {
    await expect(loadHookConfigs(makeDeps({
      readFile: async (p) => p.startsWith("/home/u/")
        ? JSON.stringify({ hooks: [{ event: "totally:bogus", command: "true" }] })
        : Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
    }), VOCAB)).rejects.toThrow(/totally:bogus/);
  });

  it("warns (does not throw) on block_on_nonzero for non-mutable event", async () => {
    const r = await loadHookConfigs(makeDeps({
      readFile: async (p) => p.startsWith("/home/u/")
        ? JSON.stringify({ hooks: [{ event: "turn:end", command: "true", block_on_nonzero: true }] })
        : Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
    }), VOCAB);
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]!.block_on_nonzero).toBe(true); // retained, but ignored at runtime
    expect(r.warnings.join("\n")).toMatch(/block_on_nonzero.*turn:end/);
  });

  it("accepts block_on_nonzero on all three mutable events", async () => {
    const r = await loadHookConfigs(makeDeps({
      readFile: async (p) => p.startsWith("/home/u/")
        ? JSON.stringify({ hooks: [
            { event: "tool:before-execute", command: "true", block_on_nonzero: true },
            { event: "codemode:before-execute", command: "true", block_on_nonzero: true },
            { event: "llm:before-call", command: "true", block_on_nonzero: true },
          ]})
        : Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
    }), VOCAB);
    expect(r.warnings).toEqual([]);
    expect(r.entries).toHaveLength(3);
  });

  it("rejects entries missing event or command", async () => {
    await expect(loadHookConfigs(makeDeps({
      readFile: async (p) => p.startsWith("/home/u/")
        ? JSON.stringify({ hooks: [{ event: "turn:start" }] })
        : Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
    }), VOCAB)).rejects.toThrow(/command/);
  });

  it("MUTABLE_EVENTS contains exactly the three Spec 0 mutable events", () => {
    expect([...MUTABLE_EVENTS].sort()).toEqual([
      "codemode:before-execute",
      "llm:before-call",
      "tool:before-execute",
    ]);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `bun test plugins/llm-hooks-shell/test/config.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `config.ts`**

```ts
import { readFile as fsReadFile } from "node:fs/promises";
import { homedir } from "node:os";

export interface HookEntry {
  event: string;
  command: string;
  cwd?: string;
  block_on_nonzero?: boolean;
  timeout_ms?: number;
  env?: Record<string, string>;
  /** Internal: file source for diagnostics. */
  _source?: "home" | "project";
}

export interface ConfigDeps {
  home: string;
  cwd: string;
  readFile: (path: string) => Promise<string>;
}

export function realConfigDeps(): ConfigDeps {
  return {
    home: homedir(),
    cwd: process.cwd(),
    readFile: (p) => fsReadFile(p, "utf8"),
  };
}

export const MUTABLE_EVENTS: ReadonlySet<string> = new Set([
  "llm:before-call",
  "tool:before-execute",
  "codemode:before-execute",
]);

const HOME_REL = ".kaizen/hooks/hooks.json";
const PROJECT_REL = ".kaizen/hooks/hooks.json";

async function readMaybe(deps: ConfigDeps, path: string): Promise<string | null> {
  try {
    return await deps.readFile(path);
  } catch (e: any) {
    if (e?.code === "ENOENT") return null;
    throw e;
  }
}

function parseFile(path: string, text: string): HookEntry[] {
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`llm-hooks-shell: config at ${path} is malformed JSON: ${(e as Error).message}`);
  }
  const hooks = parsed?.hooks;
  if (!Array.isArray(hooks)) {
    throw new Error(`llm-hooks-shell: config at ${path} must have a "hooks" array`);
  }
  for (const h of hooks) {
    if (typeof h?.event !== "string" || h.event.length === 0) {
      throw new Error(`llm-hooks-shell: config at ${path} has an entry missing "event": ${JSON.stringify(h)}`);
    }
    if (typeof h?.command !== "string" || h.command.length === 0) {
      throw new Error(`llm-hooks-shell: config at ${path} has an entry missing "command": ${JSON.stringify(h)}`);
    }
  }
  return hooks as HookEntry[];
}

export interface LoadResult {
  entries: HookEntry[];
  warnings: string[];
}

export async function loadHookConfigs(deps: ConfigDeps, vocab: ReadonlySet<string>): Promise<LoadResult> {
  const homePath = `${deps.home}/${HOME_REL}`;
  const projectPath = `${deps.cwd}/${PROJECT_REL}`;

  const homeText = await readMaybe(deps, homePath);
  const projectText = await readMaybe(deps, projectPath);

  const home = homeText ? parseFile(homePath, homeText).map(e => ({ ...e, _source: "home" as const })) : [];
  const project = projectText ? parseFile(projectPath, projectText).map(e => ({ ...e, _source: "project" as const })) : [];
  const entries = [...home, ...project];

  const warnings: string[] = [];
  for (const e of entries) {
    if (!vocab.has(e.event)) {
      throw new Error(`llm-hooks-shell: unknown event "${e.event}" in entry: ${JSON.stringify(e)}`);
    }
    if (e.block_on_nonzero && !MUTABLE_EVENTS.has(e.event)) {
      warnings.push(`llm-hooks-shell: block_on_nonzero is ignored on non-mutable event "${e.event}" (entry: ${e.command})`);
    }
  }
  return { entries, warnings };
}
```

- [ ] **Step 5: Run tests**

Run: `bun test plugins/llm-hooks-shell/test/config.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 6: Commit**

```bash
git add plugins/llm-hooks-shell/config.ts plugins/llm-hooks-shell/test/config.test.ts plugins/llm-hooks-shell/test/fixtures/
git commit -m "feat(llm-hooks-shell): config parser, merger, and VOCAB validation"
```

---

## Task H3: `envify.ts` — payload → EVENT_* environment variables

**Files:**
- Create: `plugins/llm-hooks-shell/envify.ts`
- Create: `plugins/llm-hooks-shell/test/envify.test.ts`

Pure function. Rules from Spec 12:
- `EVENT_NAME` = event name string.
- `EVENT_JSON` = full payload JSON-encoded.
- Top-level scalar → `EVENT_<KEY>` with the string value.
- Top-level object/array → `EVENT_<KEY>` containing the JSON-encoded value, AND each leaf flattened with `_` separators (`request.model` → `EVENT_REQUEST_MODEL`).
- camelCase → UPPER_SNAKE.
- Recursion depth capped at 4 — beyond that, only the JSON-encoded blob at the cap is set.

- [ ] **Step 1: Write the failing tests**

Create `plugins/llm-hooks-shell/test/envify.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { envify, camelToUpperSnake } from "../envify.ts";

describe("camelToUpperSnake", () => {
  it("turnId → TURN_ID", () => expect(camelToUpperSnake("turnId")).toBe("TURN_ID"));
  it("parentTurnId → PARENT_TURN_ID", () => expect(camelToUpperSnake("parentTurnId")).toBe("PARENT_TURN_ID"));
  it("a → A", () => expect(camelToUpperSnake("a")).toBe("A"));
  it("already_snake stays uppercased", () => expect(camelToUpperSnake("already_snake")).toBe("ALREADY_SNAKE"));
  it("HTTPRequest folds runs of capitals to a single break", () => {
    // We accept either HTTP_REQUEST or HTTPREQUEST; pick HTTP_REQUEST for readability.
    expect(camelToUpperSnake("HTTPRequest")).toBe("HTTP_REQUEST");
  });
});

describe("envify", () => {
  it("turn:start { turnId, trigger } produces the documented set", () => {
    const env = envify("turn:start", { turnId: "t-7", trigger: "user" });
    expect(env.EVENT_NAME).toBe("turn:start");
    expect(env.EVENT_TURN_ID).toBe("t-7");
    expect(env.EVENT_TRIGGER).toBe("user");
    expect(env.EVENT_JSON).toBe(JSON.stringify({ turnId: "t-7", trigger: "user" }));
  });

  it("nested payload flattens to leaf vars and JSON blob", () => {
    const env = envify("llm:before-call", {
      request: { model: "gpt-4.1", messages: [{ role: "user", content: "hi" }] },
    });
    expect(env.EVENT_REQUEST_MODEL).toBe("gpt-4.1");
    expect(env.EVENT_REQUEST_MESSAGES).toBe(JSON.stringify([{ role: "user", content: "hi" }]));
    expect(env.EVENT_REQUEST).toBe(JSON.stringify({ model: "gpt-4.1", messages: [{ role: "user", content: "hi" }] }));
  });

  it("depth cap at 4 — depth-6 payload only emits up to depth-4 leaves; deeper levels collapsed to JSON blob", () => {
    const payload: any = { a: { b: { c: { d: { e: { f: "deep" } } } } } };
    const env = envify("custom:event", payload);
    // Reachable via the cap (depth 4 from the root):
    expect(env.EVENT_A_B_C_D).toBe(JSON.stringify({ e: { f: "deep" } }));
    // Beyond cap not present:
    expect(env.EVENT_A_B_C_D_E).toBeUndefined();
    expect(env.EVENT_A_B_C_D_E_F).toBeUndefined();
  });

  it("primitive scalars stringified", () => {
    const env = envify("e", { count: 42, ok: true, nothing: null });
    expect(env.EVENT_COUNT).toBe("42");
    expect(env.EVENT_OK).toBe("true");
    expect(env.EVENT_NOTHING).toBe("null");
  });

  it("EVENT_JSON always present even for empty payload", () => {
    const env = envify("noop", {});
    expect(env.EVENT_NAME).toBe("noop");
    expect(env.EVENT_JSON).toBe("{}");
  });

  it("non-object payload is wrapped under EVENT_JSON only", () => {
    const env = envify("e", "string-payload");
    expect(env.EVENT_NAME).toBe("e");
    expect(env.EVENT_JSON).toBe(JSON.stringify("string-payload"));
  });

  it("array at top level emits the JSON blob and indexed leaves up to cap", () => {
    const env = envify("e", { items: ["a", "b"] });
    expect(env.EVENT_ITEMS).toBe(JSON.stringify(["a", "b"]));
    expect(env.EVENT_ITEMS_0).toBe("a");
    expect(env.EVENT_ITEMS_1).toBe("b");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test plugins/llm-hooks-shell/test/envify.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `envify.ts`**

```ts
const DEPTH_CAP = 4;

export function camelToUpperSnake(name: string): string {
  // Insert underscore between a lowercase or digit followed by an uppercase letter.
  // Then collapse runs of capitals so HTTPRequest → HTTP_Request → HTTP_REQUEST.
  const s1 = name.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
  const s2 = s1.replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2");
  return s2.toUpperCase();
}

function scalarString(v: unknown): string {
  if (v === null) return "null";
  if (v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

function flatten(prefix: string, value: unknown, out: Record<string, string>, depth: number): void {
  // At the depth cap, store the JSON blob and stop descending.
  if (depth >= DEPTH_CAP) {
    out[prefix] = JSON.stringify(value);
    return;
  }
  if (Array.isArray(value)) {
    out[prefix] = JSON.stringify(value);
    value.forEach((item, idx) => flatten(`${prefix}_${idx}`, item, out, depth + 1));
    return;
  }
  if (value !== null && typeof value === "object") {
    out[prefix] = JSON.stringify(value);
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const childKey = `${prefix}_${camelToUpperSnake(k)}`;
      flatten(childKey, v, out, depth + 1);
    }
    return;
  }
  out[prefix] = scalarString(value);
}

export function envify(eventName: string, payload: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  out.EVENT_NAME = eventName;
  out.EVENT_JSON = JSON.stringify(payload ?? null);

  if (payload === null || typeof payload !== "object") {
    return out;
  }

  if (Array.isArray(payload)) {
    payload.forEach((item, idx) => flatten(`EVENT_${idx}`, item, out, 1));
    return out;
  }

  for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
    flatten(`EVENT_${camelToUpperSnake(k)}`, v, out, 1);
  }
  return out;
}
```

- [ ] **Step 4: Run tests**

Run: `bun test plugins/llm-hooks-shell/test/envify.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-hooks-shell/envify.ts plugins/llm-hooks-shell/test/envify.test.ts
git commit -m "feat(llm-hooks-shell): payload → EVENT_* env-var translator with depth cap"
```

---

## Task H4: `runner.ts` — spawn one hook, log output, signal blocking outcome

**Files:**
- Create: `plugins/llm-hooks-shell/runner.ts`
- Create: `plugins/llm-hooks-shell/test/runner.test.ts`

`runHook(entry, env, deps)` returns `{ ok: boolean; stderr: string }`. On exit 0 it logs each non-empty stdout line at `info` (prefixed with `[hook event=<name>]`); on non-zero / timeout / spawn failure it logs stderr (or the failure reason) at `warn`. The harness MUST NOT crash on hook failure — all errors are caught and turned into `{ ok: false }`.

- [ ] **Step 1: Write the failing tests**

Create `plugins/llm-hooks-shell/test/runner.test.ts`:

```ts
import { describe, it, expect, mock } from "bun:test";
import { runHook, type RunnerDeps } from "../runner.ts";
import type { HookEntry } from "../config.ts";

function makeDeps(execImpl: RunnerDeps["exec"]): { deps: RunnerDeps; logs: { level: "info" | "warn"; msg: string }[] } {
  const logs: { level: "info" | "warn"; msg: string }[] = [];
  return {
    logs,
    deps: {
      exec: execImpl,
      log: (level, msg) => logs.push({ level, msg }),
    },
  };
}

const baseEntry: HookEntry = { event: "turn:start", command: "true" };

describe("runHook", () => {
  it("exit 0 + non-empty stdout → ok, info log per line", async () => {
    const { deps, logs } = makeDeps(async () => ({ exitCode: 0, stdout: "hello\nworld\n", stderr: "" }));
    const r = await runHook(baseEntry, { EVENT_NAME: "turn:start" }, deps);
    expect(r.ok).toBe(true);
    expect(r.stderr).toBe("");
    expect(logs.filter(l => l.level === "info")).toHaveLength(2);
    expect(logs[0]!.msg).toContain("[hook event=turn:start]");
    expect(logs[0]!.msg).toContain("hello");
  });

  it("exit 0 + empty stdout → ok, no info log", async () => {
    const { deps, logs } = makeDeps(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const r = await runHook(baseEntry, {}, deps);
    expect(r.ok).toBe(true);
    expect(logs).toEqual([]);
  });

  it("non-zero exit → not ok, warn log carrying stderr", async () => {
    const { deps, logs } = makeDeps(async () => ({ exitCode: 1, stdout: "", stderr: "boom\n" }));
    const r = await runHook(baseEntry, {}, deps);
    expect(r.ok).toBe(false);
    expect(r.stderr).toBe("boom\n");
    expect(logs.find(l => l.level === "warn")?.msg).toContain("boom");
  });

  it("timeout → not ok, treated like non-zero, warn log mentions timeout", async () => {
    const { deps, logs } = makeDeps(async () => { throw Object.assign(new Error("Timed out"), { code: "ETIMEDOUT" }); });
    const r = await runHook({ ...baseEntry, timeout_ms: 100 }, {}, deps);
    expect(r.ok).toBe(false);
    expect(logs.find(l => l.level === "warn")?.msg).toMatch(/timeout/i);
  });

  it("spawn failure → not ok, warn log carrying error", async () => {
    const { deps, logs } = makeDeps(async () => { throw new Error("ENOENT sh"); });
    const r = await runHook(baseEntry, {}, deps);
    expect(r.ok).toBe(false);
    expect(logs.find(l => l.level === "warn")?.msg).toMatch(/ENOENT sh/);
  });

  it("invokes sh -c with the entry command and merged env", async () => {
    let captured: any = null;
    const { deps } = makeDeps(async (bin, args, opts) => {
      captured = { bin, args, opts };
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    await runHook({ ...baseEntry, env: { EXTRA: "yes" } }, { EVENT_NAME: "turn:start" }, deps);
    expect(captured.bin).toBe("sh");
    expect(captured.args).toEqual(["-c", "true"]);
    expect(captured.opts.env).toMatchObject({ EVENT_NAME: "turn:start", EXTRA: "yes" });
  });

  it("default timeout is 30_000 ms; entry override wins", async () => {
    let captured: any = null;
    const { deps } = makeDeps(async (_b, _a, opts) => {
      captured = opts;
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    await runHook(baseEntry, {}, deps);
    expect(captured.timeoutMs).toBe(30_000);
    await runHook({ ...baseEntry, timeout_ms: 1234 }, {}, deps);
    expect(captured.timeoutMs).toBe(1234);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test plugins/llm-hooks-shell/test/runner.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `runner.ts`**

```ts
import type { HookEntry } from "./config.ts";

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunnerDeps {
  exec: (
    bin: string,
    args: string[],
    opts: { cwd?: string; env: Record<string, string>; timeoutMs: number },
  ) => Promise<ExecResult>;
  log: (level: "info" | "warn", msg: string) => void;
}

export interface HookOutcome {
  ok: boolean;
  stderr: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export async function runHook(
  entry: HookEntry,
  baseEnv: Record<string, string>,
  deps: RunnerDeps,
): Promise<HookOutcome> {
  const env = { ...baseEnv, ...(entry.env ?? {}) };
  const timeoutMs = entry.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const cwd = entry.cwd;

  let res: ExecResult;
  try {
    res = await deps.exec("sh", ["-c", entry.command], { cwd, env, timeoutMs });
  } catch (e: any) {
    const isTimeout = e?.code === "ETIMEDOUT" || /timeout/i.test(String(e?.message ?? ""));
    const reason = isTimeout ? `timeout after ${timeoutMs}ms` : (e?.message ?? String(e));
    deps.log("warn", `[hook event=${entry.event}] ${reason}`);
    return { ok: false, stderr: reason };
  }

  if (res.exitCode === 0) {
    const lines = res.stdout.split("\n").filter((l) => l.length > 0);
    for (const line of lines) {
      deps.log("info", `[hook event=${entry.event}] ${line}`);
    }
    return { ok: true, stderr: "" };
  }

  const stderrText = res.stderr || `exit ${res.exitCode}`;
  deps.log("warn", `[hook event=${entry.event}] exit=${res.exitCode} ${stderrText}`);
  return { ok: false, stderr: stderrText };
}
```

- [ ] **Step 4: Run tests**

Run: `bun test plugins/llm-hooks-shell/test/runner.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-hooks-shell/runner.ts plugins/llm-hooks-shell/test/runner.test.ts
git commit -m "feat(llm-hooks-shell): single-hook runner with logging and timeout handling"
```

---

## Task H5: `index.ts` — wire setup, subscribe, sequential per-event execution, blocking semantics

**Files:**
- Modify: `plugins/llm-hooks-shell/index.ts`
- Create: `plugins/llm-hooks-shell/test/index.test.ts`

The setup:
1. Builds real deps (`realConfigDeps`) and reads the merged config.
2. If empty, logs `info` and returns (no subscriptions).
3. Validates against `VOCAB` from `llm-events:vocabulary`. Builds an event → entries[] map.
4. For each event, registers a single handler. Handler iterates entries in config order. For each entry: build env via `envify`, call `runHook`. If `ok=false` AND `entry.block_on_nonzero` AND event is mutable → mutate payload and short-circuit remaining entries.
5. Mutation rules:
   - `tool:before-execute`: `payload.args = CANCEL_TOOL` (Symbol from `llm-events`).
   - `codemode:before-execute`: `payload.code = CODEMODE_CANCEL_SENTINEL` (string from `llm-events`).
   - `llm:before-call`: `payload.request.cancelled = true`.
6. For mutable events, when cancelling, also `ctx.emit("tool:error", { name, callId, message })` with the hook's stderr — but only for `tool:before-execute` (Spec 12 §"Blocking semantics"). For `llm:before-call` and `codemode:before-execute`, the cancellation path through `request.cancelled` / sentinel string is sufficient — the driver/codemode runner is responsible for emitting their own `*:error` events.

- [ ] **Step 1: Write the failing tests**

Create `plugins/llm-hooks-shell/test/index.test.ts`:

```ts
import { describe, it, expect, mock } from "bun:test";
import plugin from "../index.ts";
import { CANCEL_TOOL, CODEMODE_CANCEL_SENTINEL } from "llm-events";

interface Emit { event: string; payload: any }

function makeCtx(opts: {
  hooks?: any[];                            // entries to "load" from home
  projectHooks?: any[];                     // entries to "load" from project
  vocab?: string[];                         // valid event names
  exec?: (bin: string, args: string[], opts: any) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
}) {
  const subscribed: string[] = [];
  const handlers: Record<string, (p: any) => Promise<void> | void> = {};
  const emits: Emit[] = [];
  const logs: { level: "info" | "warn"; msg: string }[] = [];
  const vocab = new Set(opts.vocab ?? [
    "turn:start", "turn:end", "tool:before-execute", "codemode:before-execute",
    "llm:before-call", "llm:done", "tool:result", "conversation:cleared",
  ]);

  return {
    subscribed,
    handlers,
    emits,
    logs,
    log: (m: string) => logs.push({ level: "info", msg: m }),
    config: {},
    defineEvent: mock(() => {}),
    on: mock((name: string, fn: (p: any) => any) => { subscribed.push(name); handlers[name] = fn; }),
    emit: mock(async (event: string, payload: any) => { emits.push({ event, payload }); return []; }),
    defineService: mock(() => {}),
    provideService: mock(() => {}),
    consumeService: mock(() => {}),
    useService: mock((name: string) => {
      if (name === "llm-events:vocabulary") {
        const obj: Record<string, string> = {};
        for (const v of vocab) obj[v.toUpperCase().replace(/[:\-]/g, "_")] = v;
        return Object.freeze(obj);
      }
      return undefined;
    }),
    secrets: { get: mock(async () => undefined), refresh: mock(async () => undefined) },
    exec: { run: opts.exec ?? (async () => ({ exitCode: 0, stdout: "", stderr: "" })) },
    // Test-only injection facade.
    _testHookDeps: {
      home: "/home/u",
      cwd: "/work/proj",
      readFile: async (p: string) => {
        if (p.startsWith("/home/u/") && opts.hooks) return JSON.stringify({ hooks: opts.hooks });
        if (p.startsWith("/work/proj/") && opts.projectHooks) return JSON.stringify({ hooks: opts.projectHooks });
        const e: any = new Error("ENOENT"); e.code = "ENOENT"; throw e;
      },
    },
  } as any;
}

describe("llm-hooks-shell setup", () => {
  it("no config files → no subscriptions, single info log", async () => {
    const ctx = makeCtx({});
    await plugin.setup(ctx);
    expect(ctx.subscribed).toEqual([]);
    expect(ctx.logs.length).toBeGreaterThan(0);
  });

  it("subscribes to the union of event names from the merged config", async () => {
    const ctx = makeCtx({
      hooks: [{ event: "turn:start", command: "echo a" }],
      projectHooks: [{ event: "turn:end", command: "echo b" }],
    });
    await plugin.setup(ctx);
    expect(ctx.subscribed.sort()).toEqual(["turn:end", "turn:start"]);
  });

  it("rejects unknown event in config (refuses to start)", async () => {
    const ctx = makeCtx({ hooks: [{ event: "totally:bogus", command: "echo a" }] });
    await expect(plugin.setup(ctx)).rejects.toThrow(/totally:bogus/);
  });

  it("successful hook (exit 0) does not block tool:before-execute", async () => {
    const ctx = makeCtx({
      hooks: [{ event: "tool:before-execute", command: "true", block_on_nonzero: true }],
      exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    });
    await plugin.setup(ctx);
    const payload: any = { name: "bash", args: { cmd: "ls" }, callId: "c1" };
    await ctx.handlers["tool:before-execute"]!(payload);
    expect(payload.args).toEqual({ cmd: "ls" });
  });

  it("failing hook (exit 1) without block_on_nonzero does NOT cancel tool:before-execute", async () => {
    const ctx = makeCtx({
      hooks: [{ event: "tool:before-execute", command: "false" }],
      exec: async () => ({ exitCode: 1, stdout: "", stderr: "denied" }),
    });
    await plugin.setup(ctx);
    const payload: any = { name: "bash", args: { cmd: "ls" }, callId: "c1" };
    await ctx.handlers["tool:before-execute"]!(payload);
    expect(payload.args).toEqual({ cmd: "ls" });
  });

  it("failing hook with block_on_nonzero: true on tool:before-execute cancels via CANCEL_TOOL and emits tool:error", async () => {
    const ctx = makeCtx({
      hooks: [{ event: "tool:before-execute", command: "false", block_on_nonzero: true }],
      exec: async () => ({ exitCode: 1, stdout: "", stderr: "denied by gate\n" }),
    });
    await plugin.setup(ctx);
    const payload: any = { name: "bash", args: { cmd: "rm -rf /" }, callId: "c1" };
    await ctx.handlers["tool:before-execute"]!(payload);
    expect(payload.args).toBe(CANCEL_TOOL);
    const errEmit = ctx.emits.find((e: Emit) => e.event === "tool:error");
    expect(errEmit?.payload.callId).toBe("c1");
    expect(errEmit?.payload.message).toContain("denied by gate");
  });

  it("blocking on codemode:before-execute mutates payload.code to CODEMODE_CANCEL_SENTINEL", async () => {
    const ctx = makeCtx({
      hooks: [{ event: "codemode:before-execute", command: "false", block_on_nonzero: true }],
      exec: async () => ({ exitCode: 1, stdout: "", stderr: "no" }),
    });
    await plugin.setup(ctx);
    const payload: any = { code: "console.log('hi')" };
    await ctx.handlers["codemode:before-execute"]!(payload);
    expect(payload.code).toBe(CODEMODE_CANCEL_SENTINEL);
  });

  it("blocking on llm:before-call sets payload.request.cancelled = true", async () => {
    const ctx = makeCtx({
      hooks: [{ event: "llm:before-call", command: "false", block_on_nonzero: true }],
      exec: async () => ({ exitCode: 1, stdout: "", stderr: "stop" }),
    });
    await plugin.setup(ctx);
    const payload: any = { request: { model: "x", messages: [] } };
    await ctx.handlers["llm:before-call"]!(payload);
    expect(payload.request.cancelled).toBe(true);
  });

  it("multiple hooks on same event run in config order (home before project)", async () => {
    const calls: string[] = [];
    const ctx = makeCtx({
      hooks: [{ event: "turn:start", command: "echo home" }],
      projectHooks: [{ event: "turn:start", command: "echo project" }],
      exec: async (_b, args) => { calls.push(args[1]!); return { exitCode: 0, stdout: "", stderr: "" }; },
    });
    await plugin.setup(ctx);
    await ctx.handlers["turn:start"]!({ turnId: "t-1" });
    expect(calls).toEqual(["echo home", "echo project"]);
  });

  it("blocking failure on hook #1 short-circuits hook #2", async () => {
    const calls: string[] = [];
    const ctx = makeCtx({
      hooks: [
        { event: "tool:before-execute", command: "deny", block_on_nonzero: true },
        { event: "tool:before-execute", command: "log" },
      ],
      exec: async (_b, args) => {
        calls.push(args[1]!);
        if (args[1] === "deny") return { exitCode: 1, stdout: "", stderr: "no" };
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    await plugin.setup(ctx);
    await ctx.handlers["tool:before-execute"]!({ name: "bash", args: {}, callId: "c1" });
    expect(calls).toEqual(["deny"]);
  });

  it("non-blocking failure does NOT short-circuit subsequent hooks", async () => {
    const calls: string[] = [];
    const ctx = makeCtx({
      hooks: [
        { event: "turn:start", command: "fail" },
        { event: "turn:start", command: "audit" },
      ],
      exec: async (_b, args) => {
        calls.push(args[1]!);
        if (args[1] === "fail") return { exitCode: 1, stdout: "", stderr: "x" };
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    await plugin.setup(ctx);
    await ctx.handlers["turn:start"]!({ turnId: "t-1" });
    expect(calls).toEqual(["fail", "audit"]);
  });

  it("block_on_nonzero on a non-mutable event logs a setup warning and is ignored at runtime", async () => {
    const calls: string[] = [];
    const ctx = makeCtx({
      hooks: [{ event: "turn:end", command: "boom", block_on_nonzero: true }],
      exec: async (_b, args) => {
        calls.push(args[1]!);
        return { exitCode: 1, stdout: "", stderr: "" };
      },
    });
    await plugin.setup(ctx);
    expect(ctx.logs.some((l) => /block_on_nonzero.*turn:end/.test(l.msg))).toBe(true);
    // Hook still runs:
    await ctx.handlers["turn:end"]!({ turnId: "t-1", reason: "complete" });
    expect(calls).toEqual(["boom"]);
  });

  it("env vars include EVENT_NAME and the flattened payload", async () => {
    let captured: any = null;
    const ctx = makeCtx({
      hooks: [{ event: "turn:start", command: "echo", env: { EXTRA: "yes" } }],
      exec: async (_b, _a, opts) => { captured = opts.env; return { exitCode: 0, stdout: "", stderr: "" }; },
    });
    await plugin.setup(ctx);
    await ctx.handlers["turn:start"]!({ turnId: "t-7", trigger: "user" });
    expect(captured.EVENT_NAME).toBe("turn:start");
    expect(captured.EVENT_TURN_ID).toBe("t-7");
    expect(captured.EVENT_TRIGGER).toBe("user");
    expect(captured.EXTRA).toBe("yes");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test plugins/llm-hooks-shell/test/index.test.ts`
Expected: FAIL — placeholder index.ts has no behavior.

- [ ] **Step 3: Implement `index.ts`**

Replace `plugins/llm-hooks-shell/index.ts`:

```ts
import type { KaizenPlugin } from "kaizen/types";
import { CANCEL_TOOL, CODEMODE_CANCEL_SENTINEL } from "llm-events";
import { loadHookConfigs, MUTABLE_EVENTS, realConfigDeps, type ConfigDeps, type HookEntry } from "./config.ts";
import { envify } from "./envify.ts";
import { runHook, type RunnerDeps } from "./runner.ts";

const plugin: KaizenPlugin = {
  name: "llm-hooks-shell",
  apiVersion: "3.0.0",
  permissions: {
    tier: "unscoped",
    exec: { binaries: ["sh"] },
  },
  services: { consumes: ["llm-events:vocabulary"] },

  async setup(ctx) {
    ctx.consumeService("llm-events:vocabulary");

    const vocabObj = ctx.useService<Record<string, string>>("llm-events:vocabulary") ?? {};
    const vocab = new Set(Object.values(vocabObj));

    const configDeps: ConfigDeps = (ctx as any)._testHookDeps ?? realConfigDeps();
    const { entries, warnings } = await loadHookConfigs(configDeps, vocab);

    for (const w of warnings) ctx.log(w);

    if (entries.length === 0) {
      ctx.log("llm-hooks-shell: no hooks configured (looked at ~/.kaizen/hooks/hooks.json and <cwd>/.kaizen/hooks/hooks.json). Plugin loaded as a no-op.");
      return;
    }

    // Group entries by event, preserving order.
    const byEvent = new Map<string, HookEntry[]>();
    for (const e of entries) {
      const arr = byEvent.get(e.event) ?? [];
      arr.push(e);
      byEvent.set(e.event, arr);
    }

    const runnerDeps: RunnerDeps = {
      exec: (bin, args, opts) => ctx.exec.run(bin, args, opts),
      log: (level, msg) => ctx.log(`[${level}] ${msg}`),
    };

    for (const [eventName, hooks] of byEvent.entries()) {
      ctx.on(eventName, async (payload: any) => {
        for (const entry of hooks) {
          const env = envify(eventName, payload);
          const outcome = await runHook(entry, env, runnerDeps);

          if (outcome.ok) continue;

          // Hook failed. Apply blocking semantics if applicable.
          if (entry.block_on_nonzero && MUTABLE_EVENTS.has(eventName)) {
            if (eventName === "tool:before-execute") {
              payload.args = CANCEL_TOOL;
              await ctx.emit("tool:error", {
                name: payload.name,
                callId: payload.callId,
                message: `cancelled by hook: ${outcome.stderr}`.trim(),
              });
            } else if (eventName === "codemode:before-execute") {
              payload.code = CODEMODE_CANCEL_SENTINEL;
            } else if (eventName === "llm:before-call") {
              if (payload.request) payload.request.cancelled = true;
            }
            // Short-circuit remaining hooks for this event delivery.
            return;
          }
          // Non-blocking failure: continue to next hook.
        }
      });
    }
  },
};

export default plugin;
```

- [ ] **Step 4: Run tests**

Run: `bun test plugins/llm-hooks-shell/`
Expected: PASS, all hooks-shell tests (config + envify + runner + index = 41 tests).

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-hooks-shell/index.ts plugins/llm-hooks-shell/test/index.test.ts
git commit -m "feat(llm-hooks-shell): wire setup, subscriptions, sequential exec, blocking semantics"
```

---

## Task H6: Integration test — `tool:before-execute` blocker against a mocked driver

**Files:**
- Create: `plugins/llm-hooks-shell/test/integration.test.ts`

This test wires a tiny event bus + a fake tool registry to verify the end-to-end cancellation: `tool:before-execute` fires with mutable args, the hook plugin mutates `args = CANCEL_TOOL`, the registry sees the sentinel and skips execution, and a `tool:error` is on the bus. This is the C-tier integration described in the spec acceptance criteria.

- [ ] **Step 1: Write the failing test**

Create `plugins/llm-hooks-shell/test/integration.test.ts`:

```ts
import { describe, it, expect, mock } from "bun:test";
import plugin from "../index.ts";
import { CANCEL_TOOL } from "llm-events";

function makeBusCtx(opts: { hooks: any[]; exec: (bin: string, args: string[], opts: any) => Promise<{ exitCode: number; stdout: string; stderr: string }> }) {
  const subs: Record<string, ((p: any) => Promise<void> | void)[]> = {};
  const allEmits: { event: string; payload: any }[] = [];
  const ctx: any = {
    log: () => {},
    config: {},
    defineEvent: () => {},
    on: (name: string, fn: any) => { (subs[name] ??= []).push(fn); },
    emit: async (event: string, payload: any) => {
      allEmits.push({ event, payload });
      const handlers = subs[event] ?? [];
      for (const h of handlers) await h(payload);
      return [];
    },
    defineService: () => {},
    provideService: () => {},
    consumeService: () => {},
    useService: (name: string) => {
      if (name === "llm-events:vocabulary") {
        return Object.freeze({ TOOL_BEFORE_EXECUTE: "tool:before-execute", TOOL_ERROR: "tool:error", TOOL_RESULT: "tool:result" });
      }
      return undefined;
    },
    secrets: { get: mock(async () => undefined), refresh: mock(async () => undefined) },
    exec: { run: opts.exec },
    _testHookDeps: {
      home: "/home/u",
      cwd: "/work/proj",
      readFile: async (p: string) => p.startsWith("/home/u/")
        ? JSON.stringify({ hooks: opts.hooks })
        : (() => { const e: any = new Error("ENOENT"); e.code = "ENOENT"; throw e; })(),
    },
  };
  return { ctx, allEmits };
}

describe("llm-hooks-shell integration", () => {
  it("blocking hook on tool:before-execute prevents tool:execute and surfaces tool:error", async () => {
    const executedTools: any[] = [];
    const { ctx, allEmits } = makeBusCtx({
      hooks: [{ event: "tool:before-execute", command: "false", block_on_nonzero: true }],
      exec: async () => ({ exitCode: 1, stdout: "", stderr: "blocked\n" }),
    });

    // Fake tool registry: subscribe to tool:before-execute AFTER the hooks plugin
    // (deterministic delivery order: registration order). Skip if args === CANCEL_TOOL.
    await plugin.setup(ctx);
    ctx.on("tool:before-execute", async (payload: any) => {
      if (payload.args === CANCEL_TOOL) return; // cancelled
      executedTools.push({ name: payload.name, args: payload.args });
      await ctx.emit("tool:result", { callId: payload.callId, result: "ok" });
    });

    await ctx.emit("tool:before-execute", { name: "bash", args: { cmd: "rm -rf /" }, callId: "c1" });

    expect(executedTools).toEqual([]);
    const errs = allEmits.filter((e) => e.event === "tool:error");
    expect(errs).toHaveLength(1);
    expect(errs[0]!.payload.callId).toBe("c1");
    expect(errs[0]!.payload.message).toContain("blocked");
  });

  it("audit hook on turn:start receives the turn id in the env", async () => {
    let captured: Record<string, string> | null = null;
    const { ctx } = makeBusCtx({
      hooks: [{ event: "turn:start", command: "echo $EVENT_TURN_ID" }],
      exec: async (_b, _a, opts) => { captured = opts.env; return { exitCode: 0, stdout: "t-42\n", stderr: "" }; },
    });
    // Add turn:start to the vocab so config validation passes.
    ctx.useService = (name: string) => {
      if (name === "llm-events:vocabulary") return Object.freeze({ TURN_START: "turn:start" });
      return undefined;
    };
    await plugin.setup(ctx);
    await ctx.emit("turn:start", { turnId: "t-42", trigger: "user" });
    expect(captured?.EVENT_TURN_ID).toBe("t-42");
  });
});
```

- [ ] **Step 2: Run the test**

Run: `bun test plugins/llm-hooks-shell/test/integration.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 3: Commit**

```bash
git add plugins/llm-hooks-shell/test/integration.test.ts
git commit -m "test(llm-hooks-shell): integration coverage for blocking tool:before-execute and audit env"
```

---

## Task H7: Marketplace catalog — register `llm-hooks-shell`

**Files:**
- Modify: `.kaizen/marketplace.json`

- [ ] **Step 1: Edit `.kaizen/marketplace.json`**

Append the following object to the `entries` array (alongside the `llm-status-items` entry from Task S5):

```json
{
  "kind": "plugin",
  "name": "llm-hooks-shell",
  "description": "Optional shell-command hooks for harness events (audit / blocking gates / notifications). Unscoped — runs arbitrary shell.",
  "categories": ["hooks", "llm", "automation"],
  "versions": [{ "version": "0.1.0", "source": { "type": "file", "path": "plugins/llm-hooks-shell" } }]
}
```

- [ ] **Step 2: Verify JSON is valid**

Run: `bun -e "JSON.parse(await Bun.file('.kaizen/marketplace.json').text()); console.log('ok')"`
Expected: prints `ok`.

- [ ] **Step 3: Commit**

```bash
git add .kaizen/marketplace.json
git commit -m "chore(marketplace): publish llm-hooks-shell@0.1.0"
```

---

## Task H8: Final verification across both plugins

**Files:** none modified.

- [ ] **Step 1: Run the full test suite**

Run: `bun test plugins/llm-events/ plugins/llm-status-items/ plugins/llm-hooks-shell/`
Expected: PASS — all tests green (state, cost, status-items index, config, envify, runner, hooks-shell index, integration, llm-events).

- [ ] **Step 2: Type-check both plugins**

Run: `bun --bun tsc --noEmit -p plugins/llm-status-items/tsconfig.json plugins/llm-status-items/index.ts && bun --bun tsc --noEmit -p plugins/llm-hooks-shell/tsconfig.json plugins/llm-hooks-shell/index.ts`
Expected: no diagnostics.

- [ ] **Step 3: Verify marketplace catalog**

Run: `bun -e "const m = JSON.parse(await Bun.file('.kaizen/marketplace.json').text()); const names = m.entries.map(e => e.name); console.log(names.includes('llm-status-items'), names.includes('llm-hooks-shell'))"`
Expected: prints `true true`.

- [ ] **Step 4: Confirm neither plugin appears in the default openai-compatible harness**

Spec 12 says: "Neither plugin appears in the default A/B/C-tier harnesses." There is currently no `harnesses/openai-compatible.json` file (Spec 13 ships it); when it is added later, omit both plugins from the default. No file change required for this plan — just confirm the omission is documented in each plugin's README (already done in Tasks S1 / H1).

Run: `ls harnesses/`
Expected: only `claude-wrapper.json` (or, if present, `openai-compatible.json` — verify it does NOT contain `official/llm-status-items` or `official/llm-hooks-shell`).

- [ ] **Step 5: No commit needed**

This task is verification only.

---

## Self-Review Notes (already applied)

- **Spec coverage:** every bullet under "Plugin 1" subscriptions, formatting rules, state machine transitions, cost rules, and test plan is covered by Tasks S2–S5. Every bullet under "Plugin 2" config schema, env-var translation, execution semantics, blocking, timeouts, concurrency, permissions, subscriptions, unit tests, and integration tests is covered by Tasks H2–H7. The acceptance-criteria bullet about `CODEMODE_CANCEL_SENTINEL` propagation is Task 0.
- **Spec 0 reconciliation:** Spec 12's "until Spec 0 specifies the cancellation mechanism for `llm:before-call`, `block_on_nonzero` is unsupported there" is RELAXED in this plan because Spec 0 §"Spec coverage gaps closed" already concretizes `request.cancelled = true` as the mechanism. Tests confirm `block_on_nonzero` works on all three mutable events. Plan-author confirmed by reading lines 514–516 of Spec 0.
- **Type/method consistency:** `CANCEL_TOOL` is a Symbol (matches Spec 0 line 409); `CODEMODE_CANCEL_SENTINEL` is a string (added in Task 0 because the codemode payload field `code` is a string). `MUTABLE_EVENTS` is a frozen set of three names defined in `config.ts` and reused in `index.ts`.
- **No placeholders.** Every step has the exact code or command needed. No "implement appropriate validation" hand-waves.
