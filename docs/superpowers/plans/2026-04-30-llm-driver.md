# llm-driver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the `llm-driver` Kaizen plugin (Spec 2) — the openai-compatible harness's coordination plugin. Owns the turn loop, conversation state, lifecycle event emission, cancellation, and the `driver:run-conversation` service. Provider-, dispatch-, and tool-registry-agnostic; works in A-tier (no tools) via graceful degradation.

**Architecture:** Microservice plugin that consumes `llm:complete`, `claude-tui:channel`, and optionally `tools:registry` + `tool-dispatch:strategy`. Layered modules: `ids → busy-messages → state → loop → cancel → index`. The `loop.ts` module hosts the single canonical `runConversation` implementation that both the interactive `start()` loop and the `driver:run-conversation` service wrapper call. Conversation state is held only as in-memory locals inside `start()`; `runConversation` does not read or mutate that state.

**Tech Stack:** TypeScript, Bun runtime, `bun:test`. No external runtime deps. Imports `llm-events/public` types only across plugin boundaries.

---

## Prerequisites & Tier-for-Parallelism Map

This plan implements one plugin (`llm-driver`). It depends on the already-shipped `llm-events` (Spec 0) and `openai-llm` (Spec 1) plugins. It does NOT modify either; it only imports type-only from `llm-events/public`.

The driver's optional consumers (`tools:registry`, `tool-dispatch:strategy`) are not yet implemented; this plan tests their absence (A-tier) and their presence via mocked stubs.

Tiers below indicate what may run in parallel (no shared writes, no read-after-write):

- **Tier 0** (sequential, blocks all others): Task 1 (scaffold package + skeleton).
- **Tier 1A** (parallel, leaf modules — no inter-task imports): Task 2 (`ids.ts`), Task 3 (`busy-messages.ts`), Task 4 (`state.ts`).
- **Tier 1B** (depends on 1A): Task 5 (`loop.ts` — A-tier path), Task 6 (`loop.ts` — multi-step strategy path), Task 7 (`loop.ts` — `llm:before-call` mutation + `cancelled` short-circuit).
- **Tier 1C** (depends on 1B): Task 8 (`cancel.ts`), Task 9 (`index.ts` — interactive loop + service registration), Task 10 (`public.d.ts`), Task 11 (integration tests for `index.ts`), Task 12 (marketplace catalog + harness file update).

## File Structure

```
plugins/llm-driver/
  index.ts                  # KaizenPlugin: setup/start, service registration, interactive loop
  loop.ts                   # runConversation implementation (sole impl of the inner loop)
  state.ts                  # interactive-loop state helpers (snapshot for rollback, currentTurn record)
  cancel.ts                 # turn:cancel subscription wiring
  ids.ts                    # turn-id generator
  busy-messages.ts          # pickBusyMessage()
  public.d.ts               # re-exports DriverService + RunConversationInput/Output from llm-events
  package.json
  tsconfig.json
  README.md
  test/
    ids.test.ts
    busy-messages.test.ts
    state.test.ts
    loop.test.ts
    cancel.test.ts
    index.test.ts
```

Boundaries:
- `ids.ts` is a 4-line pure function. Predictable in tests via DI.
- `busy-messages.ts` is a 1:1 copy of the `claude-driver` pattern.
- `state.ts` exposes `snapshotMessages(messages)` + the `CurrentTurn` shape. Pure.
- `loop.ts` exports `runConversation`. Takes deps (emit, llmComplete, registry?, strategy?, log, idGen) by parameter — no module-level side effects, fully unit-testable with mocks.
- `cancel.ts` exports `wireCancel(ctx, getCurrent)` returning a teardown.
- `index.ts` is the only I/O shell — wires `ctx.useService`, builds the deps bag, runs the interactive loop, registers `driver:run-conversation`.

`.kaizen/marketplace.json` and `harnesses/openai-compatible.json` are also modified (Task 12). The harness file may not exist yet; Task 12 creates it.

---

## Task 1: Scaffold `llm-driver` plugin skeleton (Tier 0)

**Files:**
- Create: `plugins/llm-driver/package.json`
- Create: `plugins/llm-driver/tsconfig.json`
- Create: `plugins/llm-driver/README.md`
- Create: `plugins/llm-driver/index.ts` (placeholder)
- Create: `plugins/llm-driver/public.d.ts` (placeholder)

The placeholder index/public is required so `bun install` and TypeScript can resolve the workspace package; module bodies are filled in by Tasks 9/10.

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "llm-driver",
  "version": "0.1.0",
  "description": "Coordination plugin for the openai-compatible harness: turn loop, conversation state, lifecycle events.",
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

- [ ] **Step 2: Write `tsconfig.json`** (matches `plugins/llm-events/tsconfig.json`):

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
  name: "llm-driver",
  apiVersion: "3.0.0",
  driver: true,
  permissions: { tier: "unscoped" },
  services: {
    consumes: [
      "llm-events:vocabulary",
      "claude-tui:channel",
      "llm:complete",
      "tools:registry",
      "tool-dispatch:strategy",
    ],
    provides: ["driver:run-conversation"],
  },
  async setup(ctx) {
    // Filled in by Task 9.
    ctx.defineService("driver:run-conversation", {
      description: "Run a (possibly nested) conversation against the LLM with optional tool dispatch.",
    });
  },
};

export default plugin;
```

- [ ] **Step 4: Write placeholder `public.d.ts`**

```ts
export type {
  ChatMessage,
  ToolCall,
  ToolSchema,
  LLMRequest,
  LLMResponse,
  LLMStreamEvent,
  LLMCompleteService,
} from "llm-events/public";

import type { ChatMessage } from "llm-events/public";

export interface RunConversationInput {
  systemPrompt: string;
  messages: ChatMessage[];
  toolFilter?: { tags?: string[]; names?: string[] };
  model?: string;
  parentTurnId?: string;
  signal?: AbortSignal;
}

export interface RunConversationOutput {
  finalMessage: ChatMessage;
  messages: ChatMessage[];
  usage: { promptTokens: number; completionTokens: number };
}

export interface DriverService {
  runConversation(input: RunConversationInput): Promise<RunConversationOutput>;
}
```

- [ ] **Step 5: Write `README.md`**

```markdown
# llm-driver

Coordination plugin for the openai-compatible harness. Owns the assistant turn
loop, the in-memory transcript, cancellation, and the lifecycle events from
Spec 0 (`turn:*`, `conversation:*`, `llm:*`). Consumes `llm:complete` for the
provider call and optionally `tools:registry` + `tool-dispatch:strategy` for
multi-step tool flows. Provides `driver:run-conversation` so other plugins
(notably `llm-agents`) can recursively run nested conversations as child turns.
```

- [ ] **Step 6: Refresh workspace install**

Run: `bun install`
Expected: workspace resolves `llm-driver`; no errors.

- [ ] **Step 7: Sanity test placeholder**

Run: `bun -e "import('./plugins/llm-driver/index.ts').then(m => console.log(m.default.name))"`
Expected: `llm-driver`.

- [ ] **Step 8: Commit**

```bash
git add plugins/llm-driver/
git commit -m "feat(llm-driver): scaffold plugin package (skeleton only)"
```

---

## Task 2: `ids.ts` — turn-id generator (Tier 1A, parallelizable)

**Files:**
- Create: `plugins/llm-driver/ids.ts`
- Create: `plugins/llm-driver/test/ids.test.ts`

A tiny module: a default generator using `crypto.randomUUID()` and a `makeIdGen()` factory used by tests to inject deterministic ids.

- [ ] **Step 1: Write the failing test**

```ts
// plugins/llm-driver/test/ids.test.ts
import { describe, it, expect } from "bun:test";
import { newTurnId, makeIdGen } from "../ids.ts";

describe("ids", () => {
  it("newTurnId returns a non-empty string with `turn_` prefix", () => {
    const id = newTurnId();
    expect(id.startsWith("turn_")).toBe(true);
    expect(id.length).toBeGreaterThan(5);
  });

  it("two newTurnId calls produce different ids", () => {
    expect(newTurnId()).not.toBe(newTurnId());
  });

  it("makeIdGen yields a deterministic sequence for tests", () => {
    const gen = makeIdGen(["a", "b", "c"]);
    expect(gen()).toBe("a");
    expect(gen()).toBe("b");
    expect(gen()).toBe("c");
  });

  it("makeIdGen throws when exhausted", () => {
    const gen = makeIdGen(["a"]);
    gen();
    expect(() => gen()).toThrow(/exhausted/);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `bun test plugins/llm-driver/test/ids.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `ids.ts`**

```ts
export function newTurnId(): string {
  return `turn_${crypto.randomUUID()}`;
}

export function makeIdGen(seq: string[]): () => string {
  let i = 0;
  return () => {
    if (i >= seq.length) throw new Error("makeIdGen exhausted");
    return seq[i++]!;
  };
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `bun test plugins/llm-driver/test/ids.test.ts`
Expected: 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-driver/ids.ts plugins/llm-driver/test/ids.test.ts
git commit -m "feat(llm-driver): turn-id generator with test injection seam"
```

---

## Task 3: `busy-messages.ts` (Tier 1A, parallelizable)

**Files:**
- Create: `plugins/llm-driver/busy-messages.ts`
- Create: `plugins/llm-driver/test/busy-messages.test.ts`

Mirrors the existing `plugins/claude-driver/busy-messages.ts`. Same shape so we don't reinvent.

- [ ] **Step 1: Write the failing test**

```ts
// plugins/llm-driver/test/busy-messages.test.ts
import { describe, it, expect } from "bun:test";
import { pickBusyMessage, BUSY_MESSAGES } from "../busy-messages.ts";

describe("busy-messages", () => {
  it("BUSY_MESSAGES is non-empty array of strings", () => {
    expect(Array.isArray(BUSY_MESSAGES)).toBe(true);
    expect(BUSY_MESSAGES.length).toBeGreaterThan(0);
    for (const m of BUSY_MESSAGES) expect(typeof m).toBe("string");
  });

  it("pickBusyMessage returns one of BUSY_MESSAGES", () => {
    for (let i = 0; i < 50; i++) {
      expect(BUSY_MESSAGES).toContain(pickBusyMessage());
    }
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement `busy-messages.ts`**

```ts
export const BUSY_MESSAGES: readonly string[] = Object.freeze([
  "thinking…",
  "consulting the oracle…",
  "brewing tokens…",
  "kneading bytes…",
  "pondering the orb…",
  "shuffling electrons…",
]);

export function pickBusyMessage(): string {
  return BUSY_MESSAGES[Math.floor(Math.random() * BUSY_MESSAGES.length)]!;
}
```

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-driver/busy-messages.ts plugins/llm-driver/test/busy-messages.test.ts
git commit -m "feat(llm-driver): busy message picker"
```

---

## Task 4: `state.ts` — snapshots + currentTurn record (Tier 1A, parallelizable)

**Files:**
- Create: `plugins/llm-driver/state.ts`
- Create: `plugins/llm-driver/test/state.test.ts`

Pure helpers. `snapshotMessages` produces a shallow copy used for rollback in the interactive loop. `CurrentTurn` is a value type. The `aggregateUsage` helper sums multiple `LLMResponse.usage` values across LLM calls inside one `runConversation`.

- [ ] **Step 1: Write the failing test**

```ts
// plugins/llm-driver/test/state.test.ts
import { describe, it, expect } from "bun:test";
import { snapshotMessages, aggregateUsage } from "../state.ts";
import type { ChatMessage } from "llm-events/public";

describe("snapshotMessages", () => {
  it("returns a new array with the same elements", () => {
    const a: ChatMessage[] = [{ role: "user", content: "hi" }];
    const b = snapshotMessages(a);
    expect(b).not.toBe(a);
    expect(b).toEqual(a);
  });

  it("element identity preserved (shallow copy)", () => {
    const m: ChatMessage = { role: "user", content: "hi" };
    const b = snapshotMessages([m]);
    expect(b[0]).toBe(m);
  });
});

describe("aggregateUsage", () => {
  it("returns zeros for empty input", () => {
    expect(aggregateUsage([])).toEqual({ promptTokens: 0, completionTokens: 0 });
  });

  it("sums prompt + completion tokens, ignoring undefined", () => {
    const u = aggregateUsage([
      { promptTokens: 10, completionTokens: 5 },
      undefined,
      { promptTokens: 7, completionTokens: 3 },
    ]);
    expect(u).toEqual({ promptTokens: 17, completionTokens: 8 });
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement `state.ts`**

```ts
import type { ChatMessage, LLMResponse } from "llm-events/public";

export interface CurrentTurn {
  id: string;
  controller: AbortController;
}

export function snapshotMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.slice();
}

export function aggregateUsage(
  usages: Array<LLMResponse["usage"]>,
): { promptTokens: number; completionTokens: number } {
  let p = 0;
  let c = 0;
  for (const u of usages) {
    if (!u) continue;
    p += u.promptTokens;
    c += u.completionTokens;
  }
  return { promptTokens: p, completionTokens: c };
}
```

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-driver/state.ts plugins/llm-driver/test/state.test.ts
git commit -m "feat(llm-driver): state helpers (snapshot + usage aggregation)"
```

---

## Task 5: `loop.ts` — `runConversation` A-tier single-shot path (Tier 1B)

**Files:**
- Create: `plugins/llm-driver/loop.ts`
- Create: `plugins/llm-driver/test/loop.test.ts`

This task introduces the loop module and covers the A-tier path: no registry, no strategy, single LLM call, append assistant message, return. Subsequent tasks extend the same `runConversation` to handle multi-step tool flows (Task 6) and `llm:before-call` mutation + cancellation short-circuit (Task 7).

`runConversation` takes a deps bag so it's fully unit-testable with mocked services. The deps bag is built once per plugin instance in `index.ts`.

- [ ] **Step 1: Write the failing tests (A-tier only)**

Create `plugins/llm-driver/test/loop.test.ts`:

```ts
import { describe, it, expect, mock } from "bun:test";
import { runConversation, type RunConversationDeps } from "../loop.ts";
import { makeIdGen } from "../ids.ts";
import type { LLMStreamEvent, LLMCompleteService, ChatMessage } from "llm-events/public";

function makeLlm(events: LLMStreamEvent[][]): LLMCompleteService & { calls: any[] } {
  let i = 0;
  const calls: any[] = [];
  const svc = {
    calls,
    async *complete(req: any, opts: any) {
      calls.push({ req, opts });
      const evs = events[i++] ?? [];
      for (const e of evs) yield e;
    },
    async listModels() { return []; },
  } as any;
  return svc;
}

interface RecEvent { name: string; payload: any; }
function makeEmit(): { emit: (n: string, p?: any) => Promise<void>; events: RecEvent[] } {
  const events: RecEvent[] = [];
  return {
    events,
    emit: async (name: string, payload: any) => { events.push({ name, payload }); },
  };
}

function makeDeps(overrides: Partial<RunConversationDeps> = {}): RunConversationDeps {
  const { emit } = makeEmit();
  return {
    emit,
    llmComplete: makeLlm([[{ type: "done", response: { content: "ok", finishReason: "stop" } }]]),
    registry: undefined,
    strategy: undefined,
    log: mock(() => {}),
    idGen: makeIdGen(["turn_test_1", "turn_test_2"]),
    defaultModel: "default-model",
    defaultSystemPrompt: "default-sp",
    ...overrides,
  };
}

describe("runConversation (A-tier)", () => {
  it("single-shot: emits turn:start, llm:before-call, llm:request, llm:done, turn:end", async () => {
    const { emit, events } = makeEmit();
    const llm = makeLlm([[{ type: "token", delta: "hi" }, { type: "done", response: { content: "hi", finishReason: "stop" } }]]);
    const deps = makeDeps({ emit, llmComplete: llm });
    const out = await runConversation({
      systemPrompt: "sys",
      messages: [{ role: "user", content: "yo" }],
      model: "m",
    }, deps);
    expect(events.map(e => e.name)).toEqual([
      "turn:start", "llm:before-call", "llm:request", "llm:token", "llm:done", "turn:end",
    ]);
    expect(out.messages).toEqual([
      { role: "user", content: "yo" },
      { role: "assistant", content: "hi" },
    ]);
    expect(out.finalMessage).toEqual({ role: "assistant", content: "hi" });
    expect(out.usage).toEqual({ promptTokens: 0, completionTokens: 0 });
  });

  it("turn:start carries trigger=agent and parentTurnId when supplied", async () => {
    const { emit, events } = makeEmit();
    const deps = makeDeps({ emit });
    await runConversation({
      systemPrompt: "sys", messages: [{ role: "user", content: "x" }], parentTurnId: "turn_parent",
    }, deps);
    const startEv = events.find(e => e.name === "turn:start")!;
    expect(startEv.payload.trigger).toBe("agent");
    expect(startEv.payload.parentTurnId).toBe("turn_parent");
    expect(typeof startEv.payload.turnId).toBe("string");
  });

  it("uses defaultModel when input.model is undefined", async () => {
    const llm = makeLlm([[{ type: "done", response: { content: "", finishReason: "stop" } }]]);
    const deps = makeDeps({ llmComplete: llm });
    await runConversation({ systemPrompt: "sys", messages: [] }, deps);
    expect((llm as any).calls[0].req.model).toBe("default-model");
  });

  it("does not mutate caller-supplied messages array", async () => {
    const messages: ChatMessage[] = Object.freeze([{ role: "user", content: "frozen" }]) as any;
    const llm = makeLlm([[{ type: "done", response: { content: "ok", finishReason: "stop" } }]]);
    const deps = makeDeps({ llmComplete: llm });
    const out = await runConversation({ systemPrompt: "sys", messages }, deps);
    expect(messages).toEqual([{ role: "user", content: "frozen" }]); // unchanged
    expect(out.messages).not.toBe(messages);
    expect(out.messages.length).toBe(2);
  });

  it("llm:request payload is deep-frozen", async () => {
    const { emit, events } = makeEmit();
    const deps = makeDeps({ emit });
    await runConversation({ systemPrompt: "sys", messages: [{ role: "user", content: "x" }] }, deps);
    const reqEv = events.find(e => e.name === "llm:request")!;
    expect(Object.isFrozen(reqEv.payload.request)).toBe(true);
    expect(Object.isFrozen(reqEv.payload.request.messages)).toBe(true);
  });

  it("LLM error event causes turn:error + turn:end{reason:error} and throws", async () => {
    const { emit, events } = makeEmit();
    const llm = makeLlm([[{ type: "error", message: "boom" }]]);
    const deps = makeDeps({ emit, llmComplete: llm });
    await expect(runConversation({ systemPrompt: "sys", messages: [{ role: "user", content: "x" }] }, deps))
      .rejects.toThrow(/boom/);
    const names = events.map(e => e.name);
    expect(names).toContain("turn:error");
    const endEv = events.find(e => e.name === "turn:end")!;
    expect(endEv.payload.reason).toBe("error");
  });

  it("stream ends without 'done' → error", async () => {
    const { emit, events } = makeEmit();
    const llm = makeLlm([[{ type: "token", delta: "a" }]]); // no done
    const deps = makeDeps({ emit, llmComplete: llm });
    await expect(runConversation({ systemPrompt: "sys", messages: [{ role: "user", content: "x" }] }, deps))
      .rejects.toThrow(/done/);
    const endEv = events.find(e => e.name === "turn:end")!;
    expect(endEv.payload.reason).toBe("error");
  });

  it("aggregates usage across multiple llm:done events (single call here)", async () => {
    const llm = makeLlm([[{ type: "done", response: { content: "ok", finishReason: "stop", usage: { promptTokens: 4, completionTokens: 2 } } }]]);
    const deps = makeDeps({ llmComplete: llm });
    const out = await runConversation({ systemPrompt: "sys", messages: [{ role: "user", content: "x" }] }, deps);
    expect(out.usage).toEqual({ promptTokens: 4, completionTokens: 2 });
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `bun test plugins/llm-driver/test/loop.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `loop.ts` (A-tier path only)**

Create `plugins/llm-driver/loop.ts`:

```ts
import type {
  ChatMessage,
  LLMCompleteService,
  LLMRequest,
  LLMResponse,
  ToolSchema,
} from "llm-events/public";
import { aggregateUsage } from "./state.ts";

// These optional service shapes are loose-typed here so loop.ts has no
// non-type-only dependency on packages that don't exist yet.
export interface ToolsRegistryService {
  list(filter?: { tags?: string[]; names?: string[] }): ToolSchema[];
  invoke(name: string, args: unknown, ctx: any): Promise<unknown>;
  register?(...args: unknown[]): unknown;
}

export interface ToolDispatchStrategy {
  prepareRequest(input: { availableTools: ToolSchema[] }): {
    tools?: ToolSchema[];
    systemPromptAppend?: string;
  };
  handleResponse(input: {
    response: LLMResponse;
    registry: ToolsRegistryService;
    signal: AbortSignal;
    emit: (event: string, payload: unknown) => Promise<void>;
  }): Promise<ChatMessage[]>;
}

export interface RunConversationInput {
  systemPrompt: string;
  messages: ChatMessage[];
  toolFilter?: { tags?: string[]; names?: string[] };
  model?: string;
  parentTurnId?: string;
  signal?: AbortSignal;
  /** Set by index.ts when calling for the interactive loop — turn:start is owned by start(). */
  externalTurnId?: string;
  /** Set by index.ts to label the turn trigger. Defaults to "agent". */
  trigger?: "user" | "agent";
}

export interface RunConversationOutput {
  finalMessage: ChatMessage;
  messages: ChatMessage[];
  usage: { promptTokens: number; completionTokens: number };
}

export interface RunConversationDeps {
  emit: (name: string, payload?: unknown) => Promise<void>;
  llmComplete: LLMCompleteService;
  registry: ToolsRegistryService | undefined;
  strategy: ToolDispatchStrategy | undefined;
  log: (msg: string) => void;
  idGen: () => string;
  defaultModel: string;
  defaultSystemPrompt: string;
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    for (const v of Object.values(o)) deepFreeze(v as unknown);
    Object.freeze(o);
  }
  return o;
}

function appendSystemAppend(sp: string | undefined, append: string | undefined): string | undefined {
  if (!append) return sp;
  if (!sp) return append;
  return `${sp}\n\n${append}`;
}

export async function runConversation(
  input: RunConversationInput,
  deps: RunConversationDeps,
): Promise<RunConversationOutput> {
  const ownsTurn = input.externalTurnId === undefined;
  const turnId = input.externalTurnId ?? deps.idGen();
  const trigger = input.trigger ?? "agent";

  if (ownsTurn) {
    await deps.emit("turn:start", {
      turnId,
      trigger,
      ...(input.parentTurnId !== undefined ? { parentTurnId: input.parentTurnId } : {}),
    });
  }

  const signal = input.signal ?? new AbortController().signal;
  const workingMessages: ChatMessage[] = input.messages.slice();
  const usages: Array<LLMResponse["usage"]> = [];

  try {
    // --- single LLM call (A-tier path) ---
    const additions = deps.strategy
      ? deps.strategy.prepareRequest({
          availableTools: deps.registry ? deps.registry.list(input.toolFilter) : [],
        })
      : { tools: undefined as ToolSchema[] | undefined, systemPromptAppend: undefined };

    const request: LLMRequest = {
      model: input.model ?? deps.defaultModel,
      messages: workingMessages.slice(),
      systemPrompt: appendSystemAppend(input.systemPrompt, additions.systemPromptAppend),
      tools: additions.tools,
    };

    await deps.emit("llm:before-call", { request });
    await deps.emit("llm:request", { request: deepFreeze(structuredClone(request)) });

    let finalResponse: LLMResponse | null = null;
    try {
      for await (const ev of deps.llmComplete.complete(request, { signal })) {
        if (ev.type === "token") {
          await deps.emit("llm:token", { delta: ev.delta });
        } else if (ev.type === "tool-call") {
          await deps.emit("llm:tool-call", { toolCall: ev.toolCall });
        } else if (ev.type === "done") {
          finalResponse = ev.response;
          await deps.emit("llm:done", { response: ev.response });
        } else if (ev.type === "error") {
          await deps.emit("llm:error", { message: ev.message, cause: ev.cause });
          throw Object.assign(new Error(ev.message), { name: "LLMError", cause: ev.cause });
        }
      }
    } catch (err: any) {
      if (err?.name === "AbortError" || signal.aborted) throw err;
      if (err?.name === "LLMError") throw err;
      throw err;
    }

    if (finalResponse === null) {
      throw Object.assign(new Error("stream ended without 'done' event"), { name: "LLMError" });
    }

    if (finalResponse.usage) usages.push(finalResponse.usage);

    const assistantMsg: ChatMessage = {
      role: "assistant",
      content: finalResponse.content,
      ...(finalResponse.toolCalls ? { toolCalls: finalResponse.toolCalls } : {}),
    };
    workingMessages.push(assistantMsg);

    // A-tier termination: no strategy/registry → end turn after one call.
    // (Multi-step path added in Task 6.)
    if (!deps.strategy || !deps.registry) {
      const finalMessage = workingMessages[workingMessages.length - 1]!;
      const output: RunConversationOutput = {
        finalMessage,
        messages: workingMessages,
        usage: aggregateUsage(usages),
      };
      if (ownsTurn) await deps.emit("turn:end", { turnId, reason: "complete" });
      return output;
    }

    // Placeholder: multi-step strategy loop is wired in Task 6.
    throw new Error("multi-step strategy path not implemented yet");
  } catch (err: any) {
    if (ownsTurn) {
      const isAbort = err?.name === "AbortError" || signal.aborted;
      const reason = isAbort ? "cancelled" : "error";
      if (reason === "error") {
        await deps.emit("turn:error", { turnId, message: err?.message ?? String(err), cause: err });
      }
      await deps.emit("turn:end", { turnId, reason });
    }
    throw err;
  }
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `bun test plugins/llm-driver/test/loop.test.ts`
Expected: 8 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-driver/loop.ts plugins/llm-driver/test/loop.test.ts
git commit -m "feat(llm-driver): runConversation A-tier single-shot path with lifecycle events"
```

---

## Task 6: `loop.ts` — multi-step strategy/tool loop (Tier 1B)

**Files:**
- Modify: `plugins/llm-driver/loop.ts`
- Modify: `plugins/llm-driver/test/loop.test.ts`

Replace the `throw new Error("multi-step strategy path not implemented yet")` with the real loop. The strategy returns appended messages; if non-empty, loop again. If empty, terminate.

- [ ] **Step 1: Append failing tests for the multi-step path**

Append to `plugins/llm-driver/test/loop.test.ts`:

```ts
import type { ToolDispatchStrategy, ToolsRegistryService } from "../loop.ts";

function makeRegistry(tools: any[] = []): ToolsRegistryService {
  return {
    list: () => tools as any,
    invoke: async () => undefined,
  } as any;
}

function makeStrategy(handlers: Array<(input: any) => Promise<ChatMessage[]>>): ToolDispatchStrategy & { calls: any[] } {
  let i = 0;
  const calls: any[] = [];
  return {
    calls,
    prepareRequest: ({ availableTools }) => ({ tools: availableTools, systemPromptAppend: "[strategy]" }),
    handleResponse: async (input) => {
      calls.push(input);
      const h = handlers[i++];
      if (!h) return [];
      return h(input);
    },
  } as any;
}

describe("runConversation (multi-step strategy)", () => {
  it("strategy returns one tool message → second LLM call → empty appended → done", async () => {
    const { emit, events } = makeEmit();
    const llm = makeLlm([
      [{ type: "done", response: { content: "use tool", finishReason: "tool_calls", toolCalls: [{ id: "c1", name: "f", arguments: {} }] } }],
      [{ type: "done", response: { content: "final", finishReason: "stop" } }],
    ]);
    const strategy = makeStrategy([
      async () => [{ role: "tool", content: "tool-result", toolCallId: "c1", name: "f" }],
      async () => [], // terminal
    ]);
    const deps = makeDeps({ emit, llmComplete: llm, registry: makeRegistry(), strategy });
    const out = await runConversation({
      systemPrompt: "sys",
      messages: [{ role: "user", content: "go" }],
    }, deps);
    expect(out.messages.map(m => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect((llm as any).calls.length).toBe(2);
    // strategy.prepareRequest applied systemPromptAppend
    expect((llm as any).calls[0].req.systemPrompt).toContain("[strategy]");
    // strategy.tools forwarded
    expect((llm as any).calls[0].req.tools).toEqual([]);
  });

  it("strategy.handleResponse throws → turn:error + turn:end{reason:error}", async () => {
    const { emit, events } = makeEmit();
    const llm = makeLlm([
      [{ type: "done", response: { content: "x", finishReason: "tool_calls", toolCalls: [{ id: "c1", name: "f", arguments: {} }] } }],
    ]);
    const strategy = makeStrategy([
      async () => { throw new Error("strategy boom"); },
    ]);
    const deps = makeDeps({ emit, llmComplete: llm, registry: makeRegistry(), strategy });
    await expect(runConversation({
      systemPrompt: "sys", messages: [{ role: "user", content: "x" }],
    }, deps)).rejects.toThrow(/strategy boom/);
    const endEv = events.find(e => e.name === "turn:end")!;
    expect(endEv.payload.reason).toBe("error");
  });

  it("usage aggregated across multiple llm:done events", async () => {
    const llm = makeLlm([
      [{ type: "done", response: { content: "a", finishReason: "tool_calls", toolCalls: [{ id: "c1", name: "f", arguments: {} }], usage: { promptTokens: 10, completionTokens: 2 } } }],
      [{ type: "done", response: { content: "b", finishReason: "stop", usage: { promptTokens: 12, completionTokens: 4 } } }],
    ]);
    const strategy = makeStrategy([
      async () => [{ role: "tool", content: "r", toolCallId: "c1", name: "f" }],
      async () => [],
    ]);
    const deps = makeDeps({ llmComplete: llm, registry: makeRegistry(), strategy });
    const out = await runConversation({ systemPrompt: "sys", messages: [{ role: "user", content: "x" }] }, deps);
    expect(out.usage).toEqual({ promptTokens: 22, completionTokens: 6 });
  });

  it("only registry present (no strategy) takes A-tier path (degenerate)", async () => {
    const llm = makeLlm([[{ type: "done", response: { content: "ok", finishReason: "stop" } }]]);
    const deps = makeDeps({ llmComplete: llm, registry: makeRegistry(), strategy: undefined });
    const out = await runConversation({ systemPrompt: "sys", messages: [{ role: "user", content: "x" }] }, deps);
    expect((llm as any).calls.length).toBe(1);
    expect(out.messages.length).toBe(2);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Expected: the new tests fail (the placeholder `throw` fires).

- [ ] **Step 3: Replace the A-tier termination block in `loop.ts`**

In `plugins/llm-driver/loop.ts`, find the section starting with the comment `// A-tier termination` and ending at `throw new Error("multi-step strategy path not implemented yet");`, and replace it with the full multi-step loop. The complete replacement (from just before that block to the end of the inner `try`):

```ts
    // If no registry/strategy, A-tier path: end turn after one call.
    if (!deps.strategy || !deps.registry) {
      const finalMessage = workingMessages[workingMessages.length - 1]!;
      const output: RunConversationOutput = {
        finalMessage,
        messages: workingMessages,
        usage: aggregateUsage(usages),
      };
      if (ownsTurn) await deps.emit("turn:end", { turnId, reason: "complete" });
      return output;
    }

    // --- multi-step strategy/tool loop ---
    // The first LLM call has already happened above; feed its response to the strategy now.
    let response = finalResponse;
    while (true) {
      const appended = await deps.strategy.handleResponse({
        response,
        registry: deps.registry,
        signal,
        emit: deps.emit,
      });

      if (appended.length === 0) {
        const finalMessage = workingMessages[workingMessages.length - 1]!;
        const output: RunConversationOutput = {
          finalMessage,
          messages: workingMessages,
          usage: aggregateUsage(usages),
        };
        if (ownsTurn) await deps.emit("turn:end", { turnId, reason: "complete" });
        return output;
      }

      workingMessages.push(...appended);

      // Next LLM call.
      const additions2 = deps.strategy.prepareRequest({
        availableTools: deps.registry.list(input.toolFilter),
      });
      const request2: LLMRequest = {
        model: input.model ?? deps.defaultModel,
        messages: workingMessages.slice(),
        systemPrompt: appendSystemAppend(input.systemPrompt, additions2.systemPromptAppend),
        tools: additions2.tools,
      };
      await deps.emit("llm:before-call", { request: request2 });
      await deps.emit("llm:request", { request: deepFreeze(structuredClone(request2)) });

      let nextResponse: LLMResponse | null = null;
      for await (const ev of deps.llmComplete.complete(request2, { signal })) {
        if (ev.type === "token") {
          await deps.emit("llm:token", { delta: ev.delta });
        } else if (ev.type === "tool-call") {
          await deps.emit("llm:tool-call", { toolCall: ev.toolCall });
        } else if (ev.type === "done") {
          nextResponse = ev.response;
          await deps.emit("llm:done", { response: ev.response });
        } else if (ev.type === "error") {
          await deps.emit("llm:error", { message: ev.message, cause: ev.cause });
          throw Object.assign(new Error(ev.message), { name: "LLMError", cause: ev.cause });
        }
      }

      if (nextResponse === null) {
        throw Object.assign(new Error("stream ended without 'done' event"), { name: "LLMError" });
      }
      if (nextResponse.usage) usages.push(nextResponse.usage);

      const assistantMsg2: ChatMessage = {
        role: "assistant",
        content: nextResponse.content,
        ...(nextResponse.toolCalls ? { toolCalls: nextResponse.toolCalls } : {}),
      };
      workingMessages.push(assistantMsg2);
      response = nextResponse;
    }
```

- [ ] **Step 4: Run all loop tests**

Run: `bun test plugins/llm-driver/test/loop.test.ts`
Expected: all (12) tests PASS, including A-tier and multi-step.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-driver/loop.ts plugins/llm-driver/test/loop.test.ts
git commit -m "feat(llm-driver): multi-step tool dispatch loop in runConversation"
```

---

## Task 7: `loop.ts` — `llm:before-call` mutation + `request.cancelled` short-circuit (Tier 1B)

**Files:**
- Modify: `plugins/llm-driver/loop.ts`
- Modify: `plugins/llm-driver/test/loop.test.ts`

Two related contract behaviors from Spec 0:
1. Subscribers to `llm:before-call` may mutate `request` in place (model, systemPrompt, messages, temperature, etc.). The driver passes the mutated request to `llm:complete`.
2. A subscriber may set `request.cancelled = true`. After the event resolves, the driver checks the flag and ends the turn cleanly without making the HTTP call.

- [ ] **Step 1: Append failing tests**

Append to `plugins/llm-driver/test/loop.test.ts`:

```ts
describe("runConversation (llm:before-call hooks)", () => {
  it("subscriber mutation of request is visible to llm:complete and llm:request", async () => {
    const { events } = makeEmit();
    let captured: any;
    const emit = async (name: string, payload?: any) => {
      events.push({ name, payload });
      if (name === "llm:before-call") {
        payload.request.model = "mutated";
        payload.request.systemPrompt = "mutated-sp";
      }
    };
    const llm = makeLlm([[{ type: "done", response: { content: "ok", finishReason: "stop" } }]]);
    llm.complete = (async function* (req: any) {
      captured = req;
      yield { type: "done", response: { content: "ok", finishReason: "stop" } };
    }) as any;
    const deps = makeDeps({ emit, llmComplete: llm });
    await runConversation({ systemPrompt: "orig", messages: [{ role: "user", content: "x" }], model: "orig-model" }, deps);
    expect(captured.model).toBe("mutated");
    expect(captured.systemPrompt).toBe("mutated-sp");
    const reqEv = events.find(e => e.name === "llm:request")!;
    expect(reqEv.payload.request.model).toBe("mutated");
    expect(reqEv.payload.request.systemPrompt).toBe("mutated-sp");
  });

  it("request.cancelled=true short-circuits: no llm:complete call, turn ends with reason=complete", async () => {
    const { events } = makeEmit();
    const llmCalls: any[] = [];
    const emit = async (name: string, payload?: any) => {
      events.push({ name, payload });
      if (name === "llm:before-call") payload.request.cancelled = true;
    };
    const llm = {
      async *complete(req: any) {
        llmCalls.push(req);
        yield { type: "done", response: { content: "should-not-happen", finishReason: "stop" } } as any;
      },
      async listModels() { return []; },
    } as any;
    const deps = makeDeps({ emit, llmComplete: llm });
    const out = await runConversation({ systemPrompt: "s", messages: [{ role: "user", content: "x" }] }, deps);
    expect(llmCalls.length).toBe(0);
    expect(out.messages).toEqual([{ role: "user", content: "x" }]); // no assistant appended
    const names = events.map(e => e.name);
    expect(names).not.toContain("llm:request");
    expect(names).not.toContain("llm:done");
    const endEv = events.find(e => e.name === "turn:end")!;
    expect(endEv.payload.reason).toBe("complete");
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Both tests fail: cancellation short-circuit is missing; mutation propagation is already correct because `request` is held by reference, but verify.

- [ ] **Step 3: Patch `loop.ts` — both LLM-call sites**

Find the FIRST LLM-call site in `loop.ts` (right after the first `await deps.emit("llm:before-call", { request });`). Replace the block from `await deps.emit("llm:before-call", { request });` through `await deps.emit("llm:request", { request: deepFreeze(structuredClone(request)) });` with:

```ts
    await deps.emit("llm:before-call", { request });
    if (request.cancelled === true) {
      const finalMessage = workingMessages[workingMessages.length - 1] ?? {
        role: "assistant" as const, content: "",
      };
      const output: RunConversationOutput = {
        finalMessage,
        messages: workingMessages,
        usage: aggregateUsage(usages),
      };
      if (ownsTurn) await deps.emit("turn:end", { turnId, reason: "complete" });
      return output;
    }
    await deps.emit("llm:request", { request: deepFreeze(structuredClone(request)) });
```

Find the SECOND LLM-call site (inside the `while (true)` strategy loop) and apply the same patch around `await deps.emit("llm:before-call", { request: request2 });`:

```ts
      await deps.emit("llm:before-call", { request: request2 });
      if (request2.cancelled === true) {
        const finalMessage = workingMessages[workingMessages.length - 1]!;
        const output: RunConversationOutput = {
          finalMessage,
          messages: workingMessages,
          usage: aggregateUsage(usages),
        };
        if (ownsTurn) await deps.emit("turn:end", { turnId, reason: "complete" });
        return output;
      }
      await deps.emit("llm:request", { request: deepFreeze(structuredClone(request2)) });
```

- [ ] **Step 4: Run all loop tests**

Run: `bun test plugins/llm-driver/test/loop.test.ts`
Expected: 14 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-driver/loop.ts plugins/llm-driver/test/loop.test.ts
git commit -m "feat(llm-driver): honor llm:before-call mutation and request.cancelled short-circuit"
```

---

## Task 8: `cancel.ts` — turn:cancel subscription wiring (Tier 1C)

**Files:**
- Create: `plugins/llm-driver/cancel.ts`
- Create: `plugins/llm-driver/test/cancel.test.ts`

Subscribes to `turn:cancel`. Targeted cancel (`{ turnId }`) only fires when the id matches `currentTurn.id`; bare cancel cancels current. Returns a teardown function (idempotent).

- [ ] **Step 1: Write the failing tests**

Create `plugins/llm-driver/test/cancel.test.ts`:

```ts
import { describe, it, expect, mock } from "bun:test";
import { wireCancel } from "../cancel.ts";
import type { CurrentTurn } from "../state.ts";

function makeCtx() {
  const handlers: Record<string, Function[]> = {};
  return {
    on: (name: string, fn: Function) => {
      (handlers[name] ??= []).push(fn);
      return () => {
        handlers[name] = (handlers[name] ?? []).filter(f => f !== fn);
      };
    },
    fire: async (name: string, payload?: any) => {
      for (const fn of handlers[name] ?? []) await fn(payload);
    },
    handlers,
  };
}

describe("wireCancel", () => {
  it("aborts the current turn on bare turn:cancel", async () => {
    const ctx = makeCtx();
    const ac = new AbortController();
    const current: { value: CurrentTurn | null } = { value: { id: "t1", controller: ac } };
    const teardown = wireCancel(ctx as any, () => current.value);
    expect(ac.signal.aborted).toBe(false);
    await ctx.fire("turn:cancel", {});
    expect(ac.signal.aborted).toBe(true);
    teardown();
  });

  it("ignores turn:cancel with non-matching turnId", async () => {
    const ctx = makeCtx();
    const ac = new AbortController();
    const current: { value: CurrentTurn | null } = { value: { id: "t1", controller: ac } };
    wireCancel(ctx as any, () => current.value);
    await ctx.fire("turn:cancel", { turnId: "other" });
    expect(ac.signal.aborted).toBe(false);
  });

  it("aborts on matching turnId", async () => {
    const ctx = makeCtx();
    const ac = new AbortController();
    const current: { value: CurrentTurn | null } = { value: { id: "t1", controller: ac } };
    wireCancel(ctx as any, () => current.value);
    await ctx.fire("turn:cancel", { turnId: "t1" });
    expect(ac.signal.aborted).toBe(true);
  });

  it("no-op when there is no current turn", async () => {
    const ctx = makeCtx();
    wireCancel(ctx as any, () => null);
    await expect(ctx.fire("turn:cancel", {})).resolves.toBeUndefined();
  });

  it("teardown removes the subscriber", async () => {
    const ctx = makeCtx();
    const ac = new AbortController();
    const current: { value: CurrentTurn | null } = { value: { id: "t1", controller: ac } };
    const teardown = wireCancel(ctx as any, () => current.value);
    teardown();
    await ctx.fire("turn:cancel", {});
    expect(ac.signal.aborted).toBe(false);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement `cancel.ts`**

```ts
import type { CurrentTurn } from "./state.ts";

export interface CancelCtx {
  on(event: string, handler: (payload: any) => void | Promise<void>): () => void;
}

export function wireCancel(ctx: CancelCtx, getCurrent: () => CurrentTurn | null): () => void {
  const off = ctx.on("turn:cancel", async (payload: { turnId?: string } | undefined) => {
    const current = getCurrent();
    if (!current) return;
    const targeted = payload && typeof payload.turnId === "string";
    if (targeted && payload!.turnId !== current.id) return;
    current.controller.abort();
  });
  return off;
}
```

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-driver/cancel.ts plugins/llm-driver/test/cancel.test.ts
git commit -m "feat(llm-driver): turn:cancel subscriber with targeted/bare semantics"
```

---

## Task 9: `index.ts` — interactive loop, service wiring, `conversation:cleared` (Tier 1C)

**Files:**
- Modify: `plugins/llm-driver/index.ts`
- Create: `plugins/llm-driver/test/index.test.ts`

Replaces the placeholder. Responsibilities:
1. `setup(ctx)`: define `driver:run-conversation` service, consume required services, register subscribers (turn:cancel via `wireCancel`, conversation:cleared resets messages).
2. `start(ctx)`: emit `session:start`, run interactive loop, on each input line:
   - emit `input:submit` with a `handled` flag pattern (a one-shot subscriber on `input:handled` flips a local flag; if flipped, skip dispatch).
   - otherwise: append user message, emit `conversation:user-message`, allocate `currentTurn`, emit `turn:start{trigger:"user"}` and call `runConversation` with `externalTurnId` so the inner loop does NOT re-emit turn:start/turn:end.
   - emit `conversation:assistant-message` with the final assistant message, emit `turn:end{reason:"complete"}`. On error/cancel, emit appropriate `turn:end` and roll back `messages` to the pre-turn snapshot.
3. Provide `driver:run-conversation` as a thin wrapper that calls `runConversation` with `externalTurnId === undefined` (so the inner loop owns turn:start/turn:end with `trigger:"agent"`).

The interactive loop's "input:handled short-circuit" is implemented by a synchronous flag: subscribe to `input:handled` BEFORE emitting `input:submit`, and check the flag synchronously after `await emit("input:submit", …)` returns. This works only if the bus serializes subscribers before resolving the emit Promise — Spec 0 is silent here, so we adopt that assumption (matches the existing `claude-events` event bus). If a future bus change breaks it, see Spec 2 Open Question 4.

- [ ] **Step 1: Write the failing tests**

Create `plugins/llm-driver/test/index.test.ts`:

```ts
import { describe, it, expect, mock } from "bun:test";
import plugin from "../index.ts";
import type { LLMStreamEvent } from "llm-events/public";

function makeUi(lines: string[]) {
  const out: string[] = [];
  let i = 0;
  return {
    out,
    readInput: async () => i < lines.length ? lines[i++]! : "",
    setBusy: mock((_b: boolean, _m?: string) => {}),
    writeOutput: (s: string) => out.push(s),
    writeNotice: (s: string) => out.push(`[notice]${s}`),
  };
}

function makeLlm(events: LLMStreamEvent[][]) {
  let i = 0;
  return {
    async *complete() {
      const evs = events[i++] ?? [];
      for (const e of evs) yield e;
    },
    async listModels() { return []; },
  };
}

function makeCtx(deps: { ui: any; llm: any; cleared?: () => Promise<void>; cfg?: any }) {
  const handlers: Record<string, Function[]> = {};
  const events: { name: string; payload: any }[] = [];
  const provided: Record<string, unknown> = {};
  return {
    log: mock(() => {}),
    config: deps.cfg ?? { defaultModel: "m", defaultSystemPrompt: "sp" },
    defineService: mock(() => {}),
    provideService: (name: string, impl: unknown) => { provided[name] = impl; },
    consumeService: mock(() => {}),
    useService: (name: string) => {
      if (name === "claude-tui:channel") return deps.ui;
      if (name === "llm:complete") return deps.llm;
      return undefined;
    },
    on: (name: string, fn: Function) => {
      (handlers[name] ??= []).push(fn);
      return () => { handlers[name] = (handlers[name] ?? []).filter(f => f !== fn); };
    },
    emit: async (name: string, payload?: any) => {
      events.push({ name, payload });
      for (const fn of handlers[name] ?? []) await fn(payload);
    },
    defineEvent: mock(() => {}),
    handlers,
    events,
    provided,
  } as any;
}

describe("llm-driver index", () => {
  it("metadata + setup defines + provides driver:run-conversation", async () => {
    expect(plugin.name).toBe("llm-driver");
    expect(plugin.driver).toBe(true);
    const ctx = makeCtx({ ui: makeUi([]), llm: makeLlm([]) });
    await plugin.setup!(ctx);
    expect(ctx.provided["driver:run-conversation"]).toBeDefined();
    expect(typeof (ctx.provided["driver:run-conversation"] as any).runConversation).toBe("function");
  });

  it("interactive loop happy path: two turns then exit", async () => {
    const ui = makeUi(["hello", "again", ""]);
    const llm = makeLlm([
      [{ type: "done", response: { content: "hi-1", finishReason: "stop" } }],
      [{ type: "done", response: { content: "hi-2", finishReason: "stop" } }],
    ]);
    const ctx = makeCtx({ ui, llm });
    await plugin.setup!(ctx);
    await plugin.start!(ctx);
    const names = ctx.events.map((e: any) => e.name);
    expect(names[0]).toBe("session:start");
    expect(names.at(-1)).toBe("session:end");
    const turnStarts = ctx.events.filter((e: any) => e.name === "turn:start");
    expect(turnStarts.length).toBe(2);
    for (const ts of turnStarts) expect(ts.payload.trigger).toBe("user");
    const turnEnds = ctx.events.filter((e: any) => e.name === "turn:end");
    expect(turnEnds.length).toBe(2);
    for (const te of turnEnds) expect(te.payload.reason).toBe("complete");
  });

  it("input:handled short-circuit skips dispatch and the loop reads the next line", async () => {
    const ui = makeUi(["/help", "real", ""]);
    const llm = makeLlm([
      [{ type: "done", response: { content: "real-resp", finishReason: "stop" } }],
    ]);
    const ctx = makeCtx({ ui, llm });
    // Subscribe BEFORE setup to ensure our handler sees input:submit.
    ctx.on("input:submit", async (payload: any) => {
      if (payload.text === "/help") await ctx.emit("input:handled", { by: "test" });
    });
    await plugin.setup!(ctx);
    await plugin.start!(ctx);
    const turnStarts = ctx.events.filter((e: any) => e.name === "turn:start");
    expect(turnStarts.length).toBe(1); // only the second line dispatched
    const userMsgs = ctx.events.filter((e: any) => e.name === "conversation:user-message");
    expect(userMsgs.length).toBe(1);
    expect(userMsgs[0].payload.message.content).toBe("real");
  });

  it("recoverable LLM error rolls back messages so next turn starts clean", async () => {
    const ui = makeUi(["fail", "ok", ""]);
    const llm = makeLlm([
      [{ type: "error", message: "boom" }],
      [{ type: "done", response: { content: "ok-resp", finishReason: "stop" } }],
    ]);
    const ctx = makeCtx({ ui, llm });
    await plugin.setup!(ctx);
    await plugin.start!(ctx);
    const ends = ctx.events.filter((e: any) => e.name === "turn:end");
    expect(ends.map((e: any) => e.payload.reason)).toEqual(["error", "complete"]);
    // After rollback the second turn's outgoing request should NOT include the failed
    // user message + assistant from turn 1. Verify via the llm:request snapshot.
    const reqs = ctx.events.filter((e: any) => e.name === "llm:request");
    // Two requests fired (one per turn). Second request's messages should be just [user("ok")].
    expect(reqs.length).toBe(2);
    expect(reqs[1].payload.request.messages.map((m: any) => m.content)).toEqual(["ok"]);
  });

  it("conversation:cleared resets transcript", async () => {
    const ui = makeUi(["one", "two", ""]);
    const llm = makeLlm([
      [{ type: "done", response: { content: "r1", finishReason: "stop" } }],
      [{ type: "done", response: { content: "r2", finishReason: "stop" } }],
    ]);
    const ctx = makeCtx({ ui, llm });
    await plugin.setup!(ctx);
    // Fire conversation:cleared between the two inputs by listening to input:submit
    // on `two` and clearing first.
    ctx.on("input:submit", async (p: any) => {
      if (p.text === "two") await ctx.emit("conversation:cleared", {});
    });
    await plugin.start!(ctx);
    const reqs = ctx.events.filter((e: any) => e.name === "llm:request");
    expect(reqs.length).toBe(2);
    // Second request's outgoing messages start fresh, contain only the new user line.
    expect(reqs[1].payload.request.messages.map((m: any) => m.content)).toEqual(["two"]);
  });

  it("driver:run-conversation service emits turn:start with trigger=agent and parentTurnId", async () => {
    const llm = makeLlm([
      [{ type: "done", response: { content: "child-final", finishReason: "stop" } }],
    ]);
    const ctx = makeCtx({ ui: makeUi([]), llm });
    await plugin.setup!(ctx);
    const svc = ctx.provided["driver:run-conversation"] as any;
    const out = await svc.runConversation({
      systemPrompt: "agent-sp",
      messages: [{ role: "user", content: "go" }],
      parentTurnId: "turn_parent",
    });
    expect(out.finalMessage.content).toBe("child-final");
    const startEv = ctx.events.find((e: any) => e.name === "turn:start")!;
    expect(startEv.payload.trigger).toBe("agent");
    expect(startEv.payload.parentTurnId).toBe("turn_parent");
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `bun test plugins/llm-driver/test/index.test.ts`
Expected: FAIL — placeholder index has no real `start` and no service implementation.

- [ ] **Step 3: Replace `plugins/llm-driver/index.ts`**

```ts
import type { KaizenPlugin } from "kaizen/types";
import type {
  ChatMessage,
  LLMCompleteService,
} from "llm-events/public";
import type { DriverService, RunConversationInput, RunConversationOutput } from "./public";
import { runConversation, type RunConversationDeps, type ToolDispatchStrategy, type ToolsRegistryService } from "./loop.ts";
import { snapshotMessages, type CurrentTurn } from "./state.ts";
import { newTurnId } from "./ids.ts";
import { wireCancel } from "./cancel.ts";
import { pickBusyMessage } from "./busy-messages.ts";

interface UiChannel {
  readInput(): Promise<string>;
  setBusy(b: boolean, msg?: string): void;
  writeOutput(s: string): void;
  writeNotice(s: string): void;
}

interface DriverConfig {
  defaultModel?: string;
  defaultSystemPrompt?: string;
}

const DEFAULTS = {
  defaultModel: "local-model",
  defaultSystemPrompt: "",
} as const;

const plugin: KaizenPlugin = {
  name: "llm-driver",
  apiVersion: "3.0.0",
  driver: true,
  permissions: { tier: "unscoped" },
  services: {
    consumes: [
      "llm-events:vocabulary",
      "claude-tui:channel",
      "llm:complete",
      "tools:registry",
      "tool-dispatch:strategy",
    ],
    provides: ["driver:run-conversation"],
  },

  async setup(ctx) {
    ctx.consumeService("llm-events:vocabulary");
    ctx.consumeService("claude-tui:channel");
    ctx.consumeService("llm:complete");

    ctx.defineService("driver:run-conversation", {
      description: "Run a (possibly nested) conversation against the LLM with optional tool dispatch.",
    });

    // Driver-private state for the interactive loop and the current turn.
    const state: {
      currentTurn: CurrentTurn | null;
      messages: ChatMessage[];
      systemPrompt: string;
      model: string;
    } = {
      currentTurn: null,
      messages: [],
      systemPrompt: "",
      model: "",
    };

    // Subscribers
    wireCancel(ctx as any, () => state.currentTurn);
    ctx.on("conversation:cleared", async () => { state.messages = []; });

    // Build the deps bag for runConversation. We resolve services lazily inside
    // each call so consumers that load after setup() (registry/strategy) are seen.
    const buildDeps = (): RunConversationDeps => ({
      emit: ctx.emit.bind(ctx),
      llmComplete: ctx.useService<LLMCompleteService>("llm:complete")!,
      registry: ctx.useService<ToolsRegistryService>("tools:registry"),
      strategy: ctx.useService<ToolDispatchStrategy>("tool-dispatch:strategy"),
      log: ctx.log.bind(ctx),
      idGen: newTurnId,
      defaultModel: state.model || (ctx.config as DriverConfig)?.defaultModel || DEFAULTS.defaultModel,
      defaultSystemPrompt: state.systemPrompt || (ctx.config as DriverConfig)?.defaultSystemPrompt || DEFAULTS.defaultSystemPrompt,
    });

    const driverService: DriverService = {
      async runConversation(input: RunConversationInput): Promise<RunConversationOutput> {
        return runConversation(input, buildDeps());
      },
    };
    ctx.provideService<DriverService>("driver:run-conversation", driverService);

    // Stash for start().
    (ctx as any).__llmDriverState = state;
    (ctx as any).__llmDriverBuildDeps = buildDeps;
  },

  async start(ctx) {
    const ui = ctx.useService<UiChannel>("claude-tui:channel")!;
    const state = (ctx as any).__llmDriverState as {
      currentTurn: CurrentTurn | null;
      messages: ChatMessage[];
      systemPrompt: string;
      model: string;
    };
    const buildDeps = (ctx as any).__llmDriverBuildDeps as () => RunConversationDeps;

    const cfg = (ctx.config ?? {}) as DriverConfig;
    state.systemPrompt = cfg.defaultSystemPrompt ?? DEFAULTS.defaultSystemPrompt;
    state.model = cfg.defaultModel ?? DEFAULTS.defaultModel;

    await ctx.emit("session:start");
    try {
      while (true) {
        const line = await ui.readInput();
        if (line === "") break;

        // input:handled short-circuit. Subscribe before emit; flag flips synchronously.
        let handled = false;
        const off = ctx.on("input:handled", () => { handled = true; });
        await ctx.emit("input:submit", { text: line });
        off();
        if (handled) continue;

        const userMsg: ChatMessage = { role: "user", content: line };
        const preTurnSnapshot = snapshotMessages(state.messages);
        state.messages.push(userMsg);
        await ctx.emit("conversation:user-message", { message: userMsg });

        const turnId = newTurnId();
        const controller = new AbortController();
        state.currentTurn = { id: turnId, controller };
        ui.setBusy(true, pickBusyMessage());
        await ctx.emit("turn:start", { turnId, trigger: "user" });

        try {
          const result = await runConversation({
            systemPrompt: state.systemPrompt,
            messages: state.messages,
            model: state.model,
            signal: controller.signal,
            externalTurnId: turnId,
            trigger: "user",
          }, buildDeps());
          state.messages = result.messages;
          await ctx.emit("conversation:assistant-message", { message: result.finalMessage });
          await ctx.emit("turn:end", { turnId, reason: "complete" });
        } catch (err: any) {
          const isAbort = err?.name === "AbortError" || controller.signal.aborted;
          if (isAbort) {
            ui.writeNotice("↯ cancelled");
            state.messages = preTurnSnapshot;
            await ctx.emit("turn:end", { turnId, reason: "cancelled" });
          } else {
            // recoverable error: roll back, surface, continue
            await ctx.emit("turn:error", { turnId, message: err?.message ?? String(err), cause: err });
            state.messages = preTurnSnapshot;
            await ctx.emit("turn:end", { turnId, reason: "error" });
          }
        } finally {
          state.currentTurn = null;
          ui.setBusy(false);
        }
      }
    } catch (err: any) {
      await ctx.emit("session:error", { message: err?.message ?? String(err), cause: err });
    } finally {
      await ctx.emit("session:end");
    }
  },
};

export default plugin;
```

- [ ] **Step 4: Run all tests**

Run: `bun test plugins/llm-driver/`
Expected: all tests across `ids`, `busy-messages`, `state`, `loop`, `cancel`, `index` PASS.

Note: in the recoverable-error test, the inner `runConversation` will emit its own `turn:error`/`turn:end` because it owns the turn when called from the interactive path with `externalTurnId === turnId` — wait. Re-check: when `externalTurnId` is set, `ownsTurn` is `false` in `loop.ts`, so the inner loop does NOT emit turn:start/turn:end/turn:error. The outer `start()` owns those. The test asserting `["error","complete"]` for `turn:end` reasons will see exactly two ends (one per turn) emitted by `start()`.

If the test fails because the inner loop double-emits, audit `loop.ts`: `ownsTurn = input.externalTurnId === undefined`. Good.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-driver/index.ts plugins/llm-driver/test/index.test.ts
git commit -m "feat(llm-driver): interactive loop, conversation:cleared, driver:run-conversation service"
```

---

## Task 10: Finalize `public.d.ts` re-exports

**Files:**
- Modify: `plugins/llm-driver/public.d.ts`

The placeholder is already correct in shape. This task ensures the import path resolves and adds an explicit re-export for the optional service shapes used by consumers (e.g., `llm-agents` will want `DriverService`).

- [ ] **Step 1: Verify the existing placeholder type-checks**

Run: `bun --bun tsc --noEmit -p plugins/llm-driver/tsconfig.json plugins/llm-driver/index.ts plugins/llm-driver/public.d.ts plugins/llm-driver/loop.ts plugins/llm-driver/state.ts plugins/llm-driver/cancel.ts plugins/llm-driver/ids.ts plugins/llm-driver/busy-messages.ts`
Expected: no diagnostics.

- [ ] **Step 2: If diagnostics, fix imports inline.**

Common issue: `kaizen/types` import — match what the existing `claude-driver/index.ts` uses. If `kaizen/types` is not resolvable, fall back to `import type { KaizenPlugin } from "../claude-driver/node_modules/kaizen/types"` or whatever the workspace points to (mirror the `openai-llm` plugin's exact import path).

- [ ] **Step 3: Commit (only if changes were needed)**

```bash
git add plugins/llm-driver/public.d.ts plugins/llm-driver/index.ts
git commit -m "chore(llm-driver): pin type-only imports for workspace resolution"
```

---

## Task 11: Synthetic-LLM integration smoke test (Tier 1C)

**Files:**
- Create: `plugins/llm-driver/test/integration.test.ts`

End-to-end smoke covering the entire driver from `setup → start → exit` with a fake `llm:complete` service that streams realistic events. No HTTP. Validates the public event sequence one more time at integration scope.

- [ ] **Step 1: Write the failing test**

```ts
// plugins/llm-driver/test/integration.test.ts
import { describe, it, expect, mock } from "bun:test";
import plugin from "../index.ts";

describe("llm-driver integration (synthetic llm:complete)", () => {
  it("session-level event sequence is exactly correct for a single turn", async () => {
    const handlers: Record<string, Function[]> = {};
    const events: { name: string; payload: any }[] = [];
    const ui = {
      i: 0,
      readInput: async function () { return this.i++ === 0 ? "hello" : ""; },
      setBusy: () => {},
      writeOutput: () => {},
      writeNotice: () => {},
    };
    const llm = {
      async *complete() {
        yield { type: "token", delta: "he" } as const;
        yield { type: "token", delta: "llo" } as const;
        yield { type: "done", response: { content: "hello", finishReason: "stop" } } as const;
      },
      async listModels() { return []; },
    };
    const ctx: any = {
      log: () => {},
      config: { defaultModel: "m", defaultSystemPrompt: "sp" },
      defineService: () => {},
      provideService: () => {},
      consumeService: () => {},
      defineEvent: () => {},
      useService: (n: string) => n === "claude-tui:channel" ? ui : n === "llm:complete" ? llm : undefined,
      on: (n: string, fn: Function) => { (handlers[n] ??= []).push(fn); return () => {}; },
      emit: async (n: string, p?: any) => { events.push({ name: n, payload: p }); for (const fn of handlers[n] ?? []) await fn(p); },
    };
    await plugin.setup!(ctx);
    await plugin.start!(ctx);
    const seq = events.map(e => e.name);
    // Required ordering checkpoints (other events may interleave but these MUST appear in order):
    expect(seq[0]).toBe("session:start");
    expect(seq.indexOf("turn:start")).toBeGreaterThan(0);
    expect(seq.indexOf("llm:before-call")).toBeGreaterThan(seq.indexOf("turn:start"));
    expect(seq.indexOf("llm:request")).toBeGreaterThan(seq.indexOf("llm:before-call"));
    expect(seq.indexOf("llm:done")).toBeGreaterThan(seq.indexOf("llm:request"));
    expect(seq.indexOf("conversation:assistant-message")).toBeGreaterThan(seq.indexOf("llm:done"));
    expect(seq.indexOf("turn:end")).toBeGreaterThan(seq.indexOf("conversation:assistant-message"));
    expect(seq.at(-1)).toBe("session:end");
  });
});
```

- [ ] **Step 2: Run, expect PASS**

Run: `bun test plugins/llm-driver/test/integration.test.ts`
Expected: 1 test PASS (it should pass on first run because all building blocks are already implemented).

- [ ] **Step 3: Commit**

```bash
git add plugins/llm-driver/test/integration.test.ts
git commit -m "test(llm-driver): integration smoke for full session event ordering"
```

---

## Task 12: Marketplace catalog + A-tier harness file

**Files:**
- Modify: `.kaizen/marketplace.json`
- Create or Modify: `harnesses/openai-compatible.json`

Adds `llm-driver@0.1.0` to the marketplace and registers it in the openai-compatible A-tier harness. Note: A-tier per Spec 0 also requires `llm-tui` (Spec 13). If `llm-tui` does not yet exist, the harness file lists `claude-tui` as the temporary `claude-tui:channel` provider (matches the driver's `consumes`). Spec 13's plan will replace that entry.

- [ ] **Step 1: Add `llm-driver` entry to `.kaizen/marketplace.json`**

In `.kaizen/marketplace.json`, append the following object to `entries` after the `openai-llm` entry:

```json
    {
      "kind": "plugin",
      "name": "llm-driver",
      "description": "Coordination plugin for the openai-compatible harness: turn loop, conversation state, lifecycle events.",
      "categories": ["driver", "llm"],
      "versions": [{ "version": "0.1.0", "source": { "type": "file", "path": "plugins/llm-driver" } }]
    },
```

And add (or merge with) the harness entry at the end of `entries`:

```json
    {
      "kind": "harness",
      "name": "openai-compatible",
      "description": "OpenAI-compatible LLM harness (A-tier: chat E2E, no tools).",
      "categories": ["harness", "llm"],
      "versions": [{ "version": "0.1.0", "path": "harnesses/openai-compatible.json" }]
    }
```

(If an existing `openai-compatible` harness entry is already present from a prior plan, do NOT duplicate; just leave it.)

- [ ] **Step 2: Create or update `harnesses/openai-compatible.json`**

If the file does not exist, create it with:

```json
{
  "name": "openai-compatible",
  "description": "OpenAI-compatible LLM harness (A-tier).",
  "version": "0.1.0",
  "plugins": [
    { "name": "llm-events", "version": "0.1.0" },
    { "name": "openai-llm", "version": "0.1.0" },
    { "name": "llm-driver", "version": "0.1.0" },
    { "name": "claude-tui", "version": "0.2.0" }
  ]
}
```

If it already exists, add the `llm-driver` entry to the `plugins` array (keep existing entries intact).

- [ ] **Step 3: Verify all tests still pass**

Run: `bun test plugins/llm-driver/`
Expected: every test PASS.

Run a workspace-wide build to catch any cross-plugin issues:

Run: `bun install && bun --bun tsc --noEmit -p plugins/llm-driver/tsconfig.json`
Expected: no diagnostics.

- [ ] **Step 4: Validate marketplace JSON**

Run: `bun -e "console.log(JSON.parse(require('node:fs').readFileSync('.kaizen/marketplace.json','utf8')).entries.find(e=>e.name==='llm-driver'))"`
Expected: prints the new entry object.

- [ ] **Step 5: Commit**

```bash
git add .kaizen/marketplace.json harnesses/openai-compatible.json
git commit -m "chore(marketplace): publish llm-driver@0.1.0 and openai-compatible A-tier harness"
```

---

## Acceptance criteria checklist

Confirm before declaring the plan implemented:

- `bun test plugins/llm-driver/` runs all unit + integration tests green.
- `loop.ts` line coverage ≥ 90% (verify with `bun test --coverage plugins/llm-driver/test/loop.test.ts plugins/llm-driver/test/cancel.test.ts plugins/llm-driver/test/index.test.ts`).
- A-tier harness (events + openai-llm + llm-driver + tui) launches and runs a chat session with no tools/strategy registered (manual smoke; out of scope for automated tests in this plan but exercised by the `index.test.ts` synthetic flow).
- `turn:cancel` aborts the current turn within one event-loop tick (verified by `cancel.test.ts`).
- `driver:run-conversation` is exposed and produces `turn:start{trigger:"agent",parentTurnId?}` correctly (verified by `index.test.ts`).
- `.kaizen/marketplace.json` contains `llm-driver@0.1.0` and `harnesses/openai-compatible.json` lists it.

## Notes on Spec 2 open questions

The plan deliberately commits to the following resolutions from Spec 2's "Open questions for downstream":

1. **`conversation:cleared` is request-style.** The driver subscribes and resets `state.messages = []`. Subscribers requesting the clear simply emit the event; they must not mutate `state.messages` directly. (Tested in `index.test.ts`.)
2. **Strategy contract is a single service.** The driver does not attempt to multiplex strategies; the harness wires exactly one (or none). (Spec 0 alignment.)
3. **Usage aggregation** sums `promptTokens + completionTokens` across all `llm:done` events in a single `runConversation`. Cached/reasoning tokens are not represented; if Spec 1 grows the `usage` shape, Spec 0 must change first per the propagation rule, then this aggregation is updated.
4. **`input:handled` is synchronous-flag-based.** Driver subscribes before emitting `input:submit`, checks the flag synchronously after `await emit(...)` resolves. Assumes the bus serializes all subscribers before resolving the emit Promise. If the bus changes, this resolves to a request/response service `input:dispatch` (raise in a follow-up plan).
5. **`session:start`/`session:end` are tied to `start()`.** Agent-only sessions (driver loaded but `start()` not invoked) do not emit them. If a future host wants this, move the emit pair into `setup()`/teardown — single-line change.
6. **TUI service name pinned to `claude-tui:channel`.** Updates when `llm-tui` (Spec 13) ships: change the `consumes` entry and the `useService` lookup. One-line change in `index.ts`.
