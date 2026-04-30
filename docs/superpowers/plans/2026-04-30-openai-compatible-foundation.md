# openai-compatible Foundation (Spec 0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the Tier 0 foundation for the openai-compatible harness — extend the already-scaffolded `llm-events` plugin so that every cross-plugin service-interface type referenced by Spec 0's acceptance criteria is exported from `llm-events/public.d.ts` without circular dependencies, with type-level and runtime tests, then publish the new version through the marketplace catalog.

**Architecture:** `llm-events` remains a single, dependency-free plugin that owns (a) the frozen `VOCAB` constant and `ctx.defineEvent` registration, (b) the `llm-events:vocabulary` service, and (c) the *shared types* that Tier 1+ plugins import. Service-interface declarations (`ToolsRegistryService`, `DriverService`, `SkillsRegistryService`, `AgentsRegistryService`, `SlashRegistryService`, `TuiCompletionService`, plus their helper types) live in `llm-events/public.d.ts` to avoid the dependency cycle that would arise if each owning plugin tried to host its own interface while every other plugin imported from it. The interfaces are pure type declarations — `llm-events` does not implement any of them; the owning plugin (Spec 1+) `provideService`s an implementation that satisfies the declared shape. This matches Spec 0 §"Shared types" and the propagation rule that Spec 0 is the authoritative location for any cross-plugin type.

**Tech Stack:** TypeScript, Bun runtime. Tests use `bun:test`. Type-only assertions via TS conditional types (no extra deps). Existing dev deps already include `@types/json-schema`.

---

## Pre-flight: What is already done

Commit `973d2a7 feat(llm-events): scaffold Tier 0 vocabulary plugin and shared types` already produced:

- `plugins/llm-events/package.json` (v0.1.0, `@types/json-schema` dev dep)
- `plugins/llm-events/tsconfig.json`
- `plugins/llm-events/index.ts` — `VOCAB` (frozen, all 31 Spec 0 event names), `CANCEL_TOOL = Symbol.for("kaizen.cancel")`, plugin metadata, `setup()` that defines the service, calls `provideService("llm-events:vocabulary", VOCAB)`, and loops `defineEvent` over `VOCAB`.
- `plugins/llm-events/public.d.ts` — exports `Vocab`, `EventName`, `ChatMessage`, `ToolCall`, `ToolSchema`, `ModelInfo`, `LLMRequest`, `LLMResponse`, `LLMStreamEvent`, `LLMCompleteService`, `CANCEL_TOOL` (declare).
- `plugins/llm-events/index.test.ts` — 5 tests: metadata, frozen VOCAB, sample event-name strings, `CANCEL_TOOL` identity, setup wires service + every name through `defineEvent`.
- `plugins/llm-events/README.md`
- `.kaizen/marketplace.json` entry for `llm-events@0.1.0`.

What is **NOT** yet done and is owned by this plan:

1. `public.d.ts` is missing the cross-plugin **service interfaces** the acceptance criteria require: `ToolsRegistryService`, `ToolHandler`, `ToolExecutionContext`, `ToolDispatchStrategy`, `DriverService`, `RunConversationInput`, `RunConversationOutput`, `SkillsRegistryService`, `SkillManifest`, `AgentsRegistryService`, `AgentManifest`, `SlashRegistryService`, `SlashCommandManifest`, `SlashCommandHandler`, `SlashCommandContext`, `TuiCompletionService`, `CompletionSource`, `CompletionItem`.
2. No type-level test confirming every name in the acceptance-criteria import list is exported.
3. No runtime test confirming `VOCAB` is **complete** (every Spec 0 event name present — current test only spot-checks 7 of 31).
4. Version bump (`0.1.0` → `0.2.0`) and marketplace catalog update so downstream specs can pin a version that contains the new types.
5. README does not mention the service-interface re-exports.

This plan does not touch `index.ts` runtime behavior (already correct) and does not create any plugin directory. The only files modified outside `plugins/llm-events/` are `.kaizen/marketplace.json`.

---

## File Structure

```
plugins/llm-events/
  index.ts            # NO CHANGE
  index.test.ts       # MODIFY: add complete-VOCAB assertion + import-list compile test
  public.d.ts         # MODIFY: add service-interface types (Tools, Driver, Skills, Agents, Slash, Tui)
  package.json        # MODIFY: bump version 0.1.0 → 0.2.0
  README.md           # MODIFY: document re-exported service interfaces
  tsconfig.json       # NO CHANGE
test/
  llm-events-imports.test-d.ts   # NEW: type-only test (uses tsc --noEmit) covering every name in Spec 0 acceptance criteria
.kaizen/marketplace.json          # MODIFY: bump llm-events version to 0.2.0
```

Boundaries:

- `public.d.ts` stays a single flat file. Spec 0 says shared types live "in the `llm-events` plugin's `public.d.ts` so every other plugin imports from one place." A single file keeps imports cheap and avoids deep-relative-path drift across the 13 dependent plugins.
- The new `test/llm-events-imports.test-d.ts` is a *type-only* file (no runtime assertions). It is exercised by a `bun --bun tsc --noEmit` run, not `bun test`, because we need to verify the types resolve at the declaration level even when no value of the type exists at runtime.
- `package.json` version bump is a separate atomic step from the marketplace update so the workspace + the catalog stay consistent in a single commit.

---

## Task 1: Strengthen the runtime `VOCAB` test (every name covered)

The existing test only checks 7 of the 31 event names by hand. Spec 0's "Acceptance criteria for Tier 0" requires that **every** event in the vocabulary table is registered with `defineEvent`. Easy to regress when adding events later; lock it down now.

**Files:**
- Modify: `plugins/llm-events/index.test.ts`

- [ ] **Step 1: Write the failing test**

Append a new `it` to the existing `describe("llm-events", ...)` block in `plugins/llm-events/index.test.ts` (after the `"CANCEL_TOOL is the well-known symbol"` test, before the existing `"provides llm-events:vocabulary..."` test):

```ts
  it("VOCAB contains every Spec 0 event name", () => {
    const expected = new Set([
      "session:start",
      "session:end",
      "session:error",
      "input:submit",
      "input:handled",
      "conversation:user-message",
      "conversation:assistant-message",
      "conversation:system-message",
      "conversation:cleared",
      "turn:start",
      "turn:end",
      "turn:cancel",
      "turn:error",
      "llm:before-call",
      "llm:request",
      "llm:token",
      "llm:tool-call",
      "llm:done",
      "llm:error",
      "tool:before-execute",
      "tool:execute",
      "tool:result",
      "tool:error",
      "codemode:code-emitted",
      "codemode:before-execute",
      "codemode:result",
      "codemode:error",
      "skill:loaded",
      "skill:available-changed",
      "status:item-update",
      "status:item-clear",
    ]);
    const actual = new Set(Object.values(VOCAB));
    // Symmetric difference must be empty.
    for (const name of expected) expect(actual.has(name)).toBe(true);
    for (const name of actual) expect(expected.has(name as string)).toBe(true);
    expect(actual.size).toBe(expected.size);
  });
```

- [ ] **Step 2: Run test to verify it passes (current `VOCAB` already complete)**

Run: `bun test plugins/llm-events/index.test.ts`
Expected: PASS, 6 tests now (was 5). The new test passes immediately because the existing `index.ts` already populates all 31 names — but we still write the test first so any future omission breaks CI.

(Note: this is a tightening test, not a true red→green TDD step; the structural invariant already holds. The value is regression protection. If the run shows FAIL, the existing `VOCAB` is missing a name — fix `plugins/llm-events/index.ts` to match the expected set, then re-run.)

- [ ] **Step 3: Commit**

```bash
git add plugins/llm-events/index.test.ts
git commit -m "test(llm-events): assert VOCAB contains every Spec 0 event name"
```

---

## Task 2: Add `tools:registry` interface types to `public.d.ts`

Spec 0 §"`tools:registry`" defines `ToolSchema` (already exported), `ToolHandler`, `ToolExecutionContext`, `ToolsRegistryService`. We add the three missing ones.

**Files:**
- Modify: `plugins/llm-events/public.d.ts`
- Modify: `plugins/llm-events/index.test.ts`

- [ ] **Step 1: Write the failing type-import test**

Append a new test to `plugins/llm-events/index.test.ts` immediately after the `"VOCAB contains every Spec 0 event name"` test:

```ts
  it("re-exports tools:registry interface types", async () => {
    // Type-only import: if the names don't exist at the declaration level,
    // the test file fails to compile under `bun test`'s tsc pass.
    type _Probe = import("./public").ToolsRegistryService extends {
      register: (...a: any[]) => any;
      list: (...a: any[]) => any;
      invoke: (...a: any[]) => any;
    } ? true : false;
    const ok: _Probe = true;
    expect(ok).toBe(true);

    type _Ctx = import("./public").ToolExecutionContext extends {
      signal: AbortSignal;
      callId: string;
      log: (msg: string) => void;
    } ? true : false;
    const ctxOk: _Ctx = true;
    expect(ctxOk).toBe(true);

    type _Handler = import("./public").ToolHandler extends
      (args: unknown, ctx: any) => Promise<unknown> ? true : false;
    const handlerOk: _Handler = true;
    expect(handlerOk).toBe(true);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test plugins/llm-events/index.test.ts`
Expected: FAIL with TypeScript errors complaining `ToolsRegistryService`, `ToolExecutionContext`, `ToolHandler` are not exported from `./public`.

- [ ] **Step 3: Add the types to `public.d.ts`**

Append to `plugins/llm-events/public.d.ts` directly after the existing `LLMCompleteService` declaration and before the trailing `export declare const CANCEL_TOOL` line (move `CANCEL_TOOL` to the very bottom of the file in Step 8 once all blocks are added):

```ts
// ---------- tools:registry (owned by `llm-tools-registry`) ----------

export interface ToolHandler {
  (args: unknown, ctx: ToolExecutionContext): Promise<unknown>;
}

export interface ToolExecutionContext {
  signal: AbortSignal;
  callId: string;
  /**
   * Id of the turn that triggered this tool call. Required when invoked from
   * inside a driver turn (used by `llm-agents` to compute recursion depth and
   * link parent/child turns); optional when invoked outside a turn (tests,
   * slash commands, ad-hoc registry use).
   */
  turnId?: string;
  log: (msg: string) => void;
}

export interface ToolsRegistryService {
  /** Returns an unregister function. */
  register(schema: ToolSchema, handler: ToolHandler): () => void;
  list(filter?: { tags?: string[]; names?: string[] }): ToolSchema[];
  /**
   * Single execution entry point. Emits `tool:before-execute`, `tool:execute`,
   * `tool:result` / `tool:error` around the handler call. Subscribers to
   * `tool:before-execute` may rewrite `args`, or set `args` to `CANCEL_TOOL`
   * to abort — the registry surfaces a cancelled call as `tool:error` with
   * message `"cancelled"`.
   */
  invoke(name: string, args: unknown, ctx: ToolExecutionContext): Promise<unknown>;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test plugins/llm-events/index.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-events/public.d.ts plugins/llm-events/index.test.ts
git commit -m "feat(llm-events): export tools:registry interface types"
```

---

## Task 3: Add `tool-dispatch:strategy` interface types

Spec 0 §"`tool-dispatch:strategy`" defines `ToolDispatchStrategy`. It references `ToolsRegistryService` (added in Task 2), `LLMResponse`, `ToolSchema`, `ChatMessage` (already present).

**Files:**
- Modify: `plugins/llm-events/public.d.ts`
- Modify: `plugins/llm-events/index.test.ts`

- [ ] **Step 1: Write the failing type test**

Append to the existing `describe("llm-events", ...)` in `plugins/llm-events/index.test.ts`:

```ts
  it("re-exports tool-dispatch:strategy interface type", () => {
    type _Strat = import("./public").ToolDispatchStrategy extends {
      prepareRequest: (...a: any[]) => any;
      handleResponse: (...a: any[]) => Promise<any>;
    } ? true : false;
    const ok: _Strat = true;
    expect(ok).toBe(true);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test plugins/llm-events/index.test.ts`
Expected: FAIL — `ToolDispatchStrategy` not found in `./public`.

- [ ] **Step 3: Add the type to `public.d.ts`**

Append to `plugins/llm-events/public.d.ts`:

```ts
// ---------- tool-dispatch:strategy (owned by `llm-native-dispatch`, `llm-codemode-dispatch`) ----------

/**
 * Bridge between LLM output and tool execution. Multiple strategies may exist;
 * the harness selects one by service name.
 */
export interface ToolDispatchStrategy {
  /**
   * Called by the driver before each LLM call. Returns *additions* to the
   * outgoing request — never replaces caller-owned fields.
   *   - `tools`: native dispatch fills this with the OpenAI tools schema.
   *   - `systemPromptAppend`: code-mode dispatch fills this with the rendered
   *     `.d.ts` API surface and code-block instructions.
   */
  prepareRequest(input: {
    availableTools: ToolSchema[];
  }): { tools?: ToolSchema[]; systemPromptAppend?: string };

  /**
   * Consumes a complete LLM response, executes any tool calls / code blocks,
   * and returns the messages that should be appended to the conversation.
   * Returns an empty array if the response was terminal (no further turn needed).
   */
  handleResponse(input: {
    response: LLMResponse;
    registry: ToolsRegistryService;
    signal: AbortSignal;
    emit: (event: string, payload: unknown) => Promise<void>;
  }): Promise<ChatMessage[]>;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test plugins/llm-events/index.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-events/public.d.ts plugins/llm-events/index.test.ts
git commit -m "feat(llm-events): export tool-dispatch strategy interface type"
```

---

## Task 4: Add `driver:run-conversation` interface types

Spec 0 §"`driver:run-conversation`" defines `DriverService`, `RunConversationInput`, `RunConversationOutput`.

**Files:**
- Modify: `plugins/llm-events/public.d.ts`
- Modify: `plugins/llm-events/index.test.ts`

- [ ] **Step 1: Write the failing type test**

Append to `index.test.ts`:

```ts
  it("re-exports driver:run-conversation interface types", () => {
    type _Driver = import("./public").DriverService extends {
      runConversation: (...a: any[]) => Promise<any>;
    } ? true : false;
    const ok: _Driver = true;
    expect(ok).toBe(true);

    type _In = import("./public").RunConversationInput extends {
      systemPrompt: string;
      messages: any[];
    } ? true : false;
    const inOk: _In = true;
    expect(inOk).toBe(true);

    type _Out = import("./public").RunConversationOutput extends {
      finalMessage: any;
      messages: any[];
      usage: { promptTokens: number; completionTokens: number };
    } ? true : false;
    const outOk: _Out = true;
    expect(outOk).toBe(true);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test plugins/llm-events/index.test.ts`
Expected: FAIL — `DriverService` / `RunConversationInput` / `RunConversationOutput` missing.

- [ ] **Step 3: Add the types to `public.d.ts`**

Append:

```ts
// ---------- driver:run-conversation (owned by `llm-driver`) ----------

export interface RunConversationInput {
  systemPrompt: string;
  messages: ChatMessage[];
  /** Restricts the tool registry view for this nested run. */
  toolFilter?: { tags?: string[]; names?: string[] };
  /** Override default model for this run. */
  model?: string;
  /** For nested-turn telemetry (set by `llm-agents` when dispatching sub-agents). */
  parentTurnId?: string;
  signal?: AbortSignal;
}

export interface RunConversationOutput {
  finalMessage: ChatMessage;
  /** Full transcript including the input messages. */
  messages: ChatMessage[];
  usage: { promptTokens: number; completionTokens: number };
}

export interface DriverService {
  runConversation(input: RunConversationInput): Promise<RunConversationOutput>;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test plugins/llm-events/index.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-events/public.d.ts plugins/llm-events/index.test.ts
git commit -m "feat(llm-events): export driver:run-conversation interface types"
```

---

## Task 5: Add `skills:registry` interface types

Spec 0 §"`skills:registry`" defines `SkillManifest`, `SkillsRegistryService` (note `rescan()` was added in the changelog).

**Files:**
- Modify: `plugins/llm-events/public.d.ts`
- Modify: `plugins/llm-events/index.test.ts`

- [ ] **Step 1: Write the failing type test**

Append to `index.test.ts`:

```ts
  it("re-exports skills:registry interface types", () => {
    type _Reg = import("./public").SkillsRegistryService extends {
      list: () => any;
      load: (name: string) => Promise<string>;
      register: (...a: any[]) => () => void;
      rescan: () => Promise<void>;
    } ? true : false;
    const ok: _Reg = true;
    expect(ok).toBe(true);

    type _Manifest = import("./public").SkillManifest extends {
      name: string;
      description: string;
    } ? true : false;
    const mOk: _Manifest = true;
    expect(mOk).toBe(true);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test plugins/llm-events/index.test.ts`
Expected: FAIL — `SkillsRegistryService` / `SkillManifest` missing.

- [ ] **Step 3: Add the types to `public.d.ts`**

Append:

```ts
// ---------- skills:registry (owned by `llm-skills`) ----------

export interface SkillManifest {
  name: string;
  description: string;
  /** Cached estimate, in tokens, used by budgeting code. */
  tokens?: number;
}

export interface SkillsRegistryService {
  list(): SkillManifest[];
  /** Returns the body to inject into the system prompt. */
  load(name: string): Promise<string>;
  register(manifest: SkillManifest, loader: () => Promise<string>): () => void;
  /** Re-discover file-backed skills; used by `/skills reload`. */
  rescan(): Promise<void>;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test plugins/llm-events/index.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-events/public.d.ts plugins/llm-events/index.test.ts
git commit -m "feat(llm-events): export skills:registry interface types"
```

---

## Task 6: Add `agents:registry` interface types

Spec 0 §"`agents:registry`" defines `AgentManifest`, `AgentsRegistryService`.

**Files:**
- Modify: `plugins/llm-events/public.d.ts`
- Modify: `plugins/llm-events/index.test.ts`

- [ ] **Step 1: Write the failing type test**

Append:

```ts
  it("re-exports agents:registry interface types", () => {
    type _Reg = import("./public").AgentsRegistryService extends {
      list: () => any;
      register: (...a: any[]) => () => void;
    } ? true : false;
    const ok: _Reg = true;
    expect(ok).toBe(true);

    type _Manifest = import("./public").AgentManifest extends {
      name: string;
      description: string;
      systemPrompt: string;
    } ? true : false;
    const mOk: _Manifest = true;
    expect(mOk).toBe(true);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test plugins/llm-events/index.test.ts`
Expected: FAIL — `AgentsRegistryService` / `AgentManifest` missing.

- [ ] **Step 3: Add the types to `public.d.ts`**

Append:

```ts
// ---------- agents:registry (owned by `llm-agents`) ----------

export interface AgentManifest {
  name: string;
  description: string;
  systemPrompt: string;
  /** Restricts the tool view available to this agent's nested driver runs. */
  toolFilter?: { tags?: string[]; names?: string[] };
}

export interface AgentsRegistryService {
  list(): AgentManifest[];
  register(manifest: AgentManifest): () => void;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test plugins/llm-events/index.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-events/public.d.ts plugins/llm-events/index.test.ts
git commit -m "feat(llm-events): export agents:registry interface types"
```

---

## Task 7: Add `slash:registry` interface types

Spec 0 §"`slash:registry`" defines `SlashCommandManifest`, `SlashCommandHandler`, `SlashCommandContext`, `SlashRegistryService`.

**Files:**
- Modify: `plugins/llm-events/public.d.ts`
- Modify: `plugins/llm-events/index.test.ts`

- [ ] **Step 1: Write the failing type test**

Append:

```ts
  it("re-exports slash:registry interface types", () => {
    type _Reg = import("./public").SlashRegistryService extends {
      register: (...a: any[]) => () => void;
      list: () => any;
      tryDispatch: (...a: any[]) => Promise<boolean>;
    } ? true : false;
    const ok: _Reg = true;
    expect(ok).toBe(true);

    type _Manifest = import("./public").SlashCommandManifest extends {
      name: string;
      description: string;
      source: "builtin" | "user" | "project" | "plugin";
    } ? true : false;
    const mOk: _Manifest = true;
    expect(mOk).toBe(true);

    type _Ctx = import("./public").SlashCommandContext extends {
      args: string;
      emit: (event: string, payload: unknown) => Promise<void>;
      signal: AbortSignal;
    } ? true : false;
    const cOk: _Ctx = true;
    expect(cOk).toBe(true);

    type _Handler = import("./public").SlashCommandHandler extends
      (ctx: any) => Promise<void> ? true : false;
    const hOk: _Handler = true;
    expect(hOk).toBe(true);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test plugins/llm-events/index.test.ts`
Expected: FAIL — slash types missing.

- [ ] **Step 3: Add the types to `public.d.ts`**

Append:

```ts
// ---------- slash:registry (owned by `llm-slash-commands`) ----------

export interface SlashCommandManifest {
  /** Without leading slash, e.g. "help" or "mcp:reload". */
  name: string;
  description: string;
  /**
   * If set, the command body is rendered with `{{args}}` substitution and
   * re-emitted as a user message. If unset, `handler` runs.
   */
  body?: string;
  source: "builtin" | "user" | "project" | "plugin";
}

export interface SlashCommandContext {
  /** Everything after the command name; a single leading space is stripped. */
  args: string;
  emit: (event: string, payload: unknown) => Promise<void>;
  signal: AbortSignal;
}

export interface SlashCommandHandler {
  (ctx: SlashCommandContext): Promise<void>;
}

export interface SlashRegistryService {
  register(manifest: SlashCommandManifest, handler?: SlashCommandHandler): () => void;
  list(): SlashCommandManifest[];
  /**
   * Returns true if the input matched a registered command (and was dispatched);
   * false if no match. Subscribers to `input:submit` call this to decide
   * whether to emit `input:handled`.
   */
  tryDispatch(input: string, ctx: Omit<SlashCommandContext, "args">): Promise<boolean>;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test plugins/llm-events/index.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-events/public.d.ts plugins/llm-events/index.test.ts
git commit -m "feat(llm-events): export slash:registry interface types"
```

---

## Task 8: Add `tui:completion` interface types

Spec 0 §"`tui:completion`" defines `CompletionSource`, `CompletionItem`, `TuiCompletionService`.

**Files:**
- Modify: `plugins/llm-events/public.d.ts`
- Modify: `plugins/llm-events/index.test.ts`

- [ ] **Step 1: Write the failing type test**

Append:

```ts
  it("re-exports tui:completion interface types", () => {
    type _Svc = import("./public").TuiCompletionService extends {
      register: (...a: any[]) => () => void;
    } ? true : false;
    const ok: _Svc = true;
    expect(ok).toBe(true);

    type _Source = import("./public").CompletionSource extends {
      trigger: string | RegExp;
      list: (input: string, cursor: number) => Promise<any[]>;
    } ? true : false;
    const sOk: _Source = true;
    expect(sOk).toBe(true);

    type _Item = import("./public").CompletionItem extends {
      label: string;
      insertText: string;
    } ? true : false;
    const iOk: _Item = true;
    expect(iOk).toBe(true);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test plugins/llm-events/index.test.ts`
Expected: FAIL — completion types missing.

- [ ] **Step 3: Add the types to `public.d.ts`**

Append:

```ts
// ---------- tui:completion (owned by `llm-tui`) ----------

export interface CompletionItem {
  /** Shown in the popup. */
  label: string;
  /** Replaces trigger+typed-text on accept. */
  insertText: string;
  /** Shown alongside `label`. */
  description?: string;
  /** Shown below the selection (preview/help). */
  detail?: string;
}

export interface CompletionSource {
  /** Matched at word-start in the input field. */
  trigger: string | RegExp;
  list(input: string, cursor: number): Promise<CompletionItem[]>;
  /** Higher weight sorts first when multiple sources merge into one popup. */
  weight?: number;
}

export interface TuiCompletionService {
  register(source: CompletionSource): () => void;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test plugins/llm-events/index.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-events/public.d.ts plugins/llm-events/index.test.ts
git commit -m "feat(llm-events): export tui:completion interface types"
```

---

## Task 9: Add the Spec-0-acceptance-criteria omnibus import test

Spec 0 explicitly enumerates 18 names that "Tier 1+ plugins can import" without circular deps. We add one consolidated test that exercises every name in a single `import type { ... } from "./public"` so any future regression breaks one obvious test.

**Files:**
- Create: `plugins/llm-events/test/acceptance-imports.test.ts`

- [ ] **Step 1: Create the test file**

```ts
import { describe, it, expect } from "bun:test";

// The Spec 0 acceptance criteria require Tier 1+ plugins to be able to import
// every one of these names from `llm-events/public.d.ts` without circular
// dependencies. This test imports them together; if any name is missing or
// renamed, this file fails to type-check and `bun test` reports the error.
import type {
  Vocab,
  ChatMessage,
  ToolCall,
  ToolSchema,
  LLMRequest,
  LLMResponse,
  LLMStreamEvent,
  ToolsRegistryService,
  ToolExecutionContext,
  ToolDispatchStrategy,
  DriverService,
  SkillsRegistryService,
  AgentsRegistryService,
  SlashRegistryService,
  TuiCompletionService,
  CompletionSource,
  CompletionItem,
} from "../public";
import { CANCEL_TOOL } from "../index.ts";

describe("llm-events: Spec 0 acceptance-criteria imports", () => {
  it("CANCEL_TOOL is the well-known Symbol.for('kaizen.cancel')", () => {
    expect(CANCEL_TOOL).toBe(Symbol.for("kaizen.cancel"));
  });

  it("every Spec 0 type name resolves at the declaration level", () => {
    // Type-only assertions: each `_Probe` line forces the compiler to confirm
    // the imported symbol is a usable type. Runtime is a no-op.
    type _V = Vocab;
    type _Cm = ChatMessage;
    type _Tc = ToolCall;
    type _Ts = ToolSchema;
    type _Lreq = LLMRequest;
    type _Lres = LLMResponse;
    type _Lse = LLMStreamEvent;
    type _Trs = ToolsRegistryService;
    type _Tec = ToolExecutionContext;
    type _Tds = ToolDispatchStrategy;
    type _Ds = DriverService;
    type _Skr = SkillsRegistryService;
    type _Agr = AgentsRegistryService;
    type _Slr = SlashRegistryService;
    type _Tcs = TuiCompletionService;
    type _Cs = CompletionSource;
    type _Ci = CompletionItem;

    // Use one of them at runtime so TS doesn't elide the whole import.
    const probe: _Cm = { role: "user", content: "ok" };
    expect(probe.role).toBe("user");
  });
});
```

- [ ] **Step 2: Run the test**

Run: `bun test plugins/llm-events/test/acceptance-imports.test.ts`
Expected: PASS, 2 tests. If any import is unresolved, bun's TS pass fails the file with `error TS2305: Module '"../public"' has no exported member 'X'`.

- [ ] **Step 3: Commit**

```bash
git add plugins/llm-events/test/acceptance-imports.test.ts
git commit -m "test(llm-events): assert Spec 0 acceptance-criteria imports resolve"
```

---

## Task 10: Run a full type-check pass over the modified plugin

Sanity check that the expanded `public.d.ts` still compiles in `strict` mode and that the workspace can resolve `@types/json-schema` (it was already a dev dep but the install may need a refresh).

**Files:** none modified.

- [ ] **Step 1: Install (idempotent)**

Run: `bun install`
Expected: success; `bun.lock` unchanged unless a transitive dep needs refresh.

- [ ] **Step 2: Type-check `llm-events`**

Run: `bun --bun tsc --noEmit -p plugins/llm-events/tsconfig.json plugins/llm-events/index.ts plugins/llm-events/public.d.ts plugins/llm-events/index.test.ts plugins/llm-events/test/acceptance-imports.test.ts`
Expected: no diagnostics.

- [ ] **Step 3: Run the full plugin test suite**

Run: `bun test plugins/llm-events/`
Expected: PASS — 13 tests in `index.test.ts` plus 2 tests in `test/acceptance-imports.test.ts` = 15 total.

(No commit — verification step only.)

---

## Task 11: Verify `openai-llm` (Spec 1) still type-checks against the expanded `public.d.ts`

The point of Spec 0 is that downstream plugins can import from `llm-events`. `openai-llm` already exists at `plugins/openai-llm/` and re-exports several types from `llm-events`. Confirm we haven't regressed it. No code change expected.

**Files:** none modified.

- [ ] **Step 1: Type-check `openai-llm`**

Run: `bun --bun tsc --noEmit -p plugins/openai-llm/tsconfig.json plugins/openai-llm/index.ts plugins/openai-llm/public.d.ts plugins/openai-llm/service.ts plugins/openai-llm/stream.ts plugins/openai-llm/parser.ts plugins/openai-llm/sse.ts plugins/openai-llm/http.ts plugins/openai-llm/retry.ts plugins/openai-llm/config.ts`
Expected: no diagnostics.

- [ ] **Step 2: Run the `openai-llm` test suite**

Run: `bun test plugins/openai-llm/`
Expected: all existing tests pass; no new failures from the type changes.

(If any failure surfaces here, it indicates a contract drift — STOP, audit the failure against Spec 0 §"Spec 0 is the source of truth — propagation rule," and either correct `public.d.ts` or open an issue against Spec 1.)

(No commit — verification step only.)

---

## Task 12: Update README to document the service-interface re-exports

The current README describes only `VOCAB`. Mention the broader role of `public.d.ts` so plugin authors know to import from here.

**Files:**
- Modify: `plugins/llm-events/README.md`

- [ ] **Step 1: Replace the README contents**

Overwrite `plugins/llm-events/README.md` with:

```markdown
# llm-events

Tier 0 foundation plugin for the openai-compatible Kaizen harness.

## What it provides

- **`llm-events:vocabulary` service** — a frozen `VOCAB` object mapping every
  Spec 0 event symbolic name (e.g. `LLM_BEFORE_CALL`) to its wire string
  (`"llm:before-call"`). Subscribers should always import this constant rather
  than hand-typing event-name strings.
- **`ctx.defineEvent` registration** for every name in `VOCAB`, so the bus
  validates `emit`/`on` calls against the known set.
- **Shared types** in `public.d.ts`. Every other `llm-*` plugin in the harness
  imports cross-plugin contracts from here to avoid circular dependencies.

## Type re-exports (cross-plugin contracts)

`public.d.ts` is the single import point for:

- Conversation primitives — `ChatMessage`, `ToolCall`, `ToolSchema`,
  `ModelInfo`, `LLMRequest`, `LLMResponse`, `LLMStreamEvent`,
  `LLMCompleteService`.
- Cancellation sentinel — `CANCEL_TOOL = Symbol.for("kaizen.cancel")`.
- Service interfaces (declared here, *implemented* by their owning plugin):
  `ToolsRegistryService`, `ToolHandler`, `ToolExecutionContext`,
  `ToolDispatchStrategy`, `DriverService`, `RunConversationInput`,
  `RunConversationOutput`, `SkillsRegistryService`, `SkillManifest`,
  `AgentsRegistryService`, `AgentManifest`, `SlashRegistryService`,
  `SlashCommandManifest`, `SlashCommandHandler`, `SlashCommandContext`,
  `TuiCompletionService`, `CompletionSource`, `CompletionItem`.

## Why interfaces live here, not in their owning plugin

Spec 0 is the propagation source-of-truth for any cross-plugin contract.
Hosting service-interface declarations in `llm-events` keeps the dependency
graph acyclic: every `llm-*` plugin depends on `llm-events`, and `llm-events`
depends on nothing. An owning plugin (e.g. `llm-driver` for `DriverService`)
implements the interface and `provideService`s a value satisfying its shape.

## Permissions

`tier: "trusted"` — matches `claude-events`.
```

- [ ] **Step 2: Commit**

```bash
git add plugins/llm-events/README.md
git commit -m "docs(llm-events): document service-interface re-exports"
```

---

## Task 13: Bump `llm-events` version to `0.2.0`

Adding new exported types is a minor (additive) change; bump minor per semver. The marketplace catalog already published `0.1.0`, so we cannot reuse that version.

**Files:**
- Modify: `plugins/llm-events/package.json`

- [ ] **Step 1: Edit `package.json`**

Change the `"version"` field in `plugins/llm-events/package.json` from `"0.1.0"` to `"0.2.0"`. The full file becomes:

```json
{
  "name": "llm-events",
  "version": "0.2.0",
  "description": "Event vocabulary and shared types for the openai-compatible harness",
  "type": "module",
  "exports": { ".": "./index.ts" },
  "keywords": ["kaizen-plugin"],
  "devDependencies": {
    "@types/bun": "latest",
    "@types/json-schema": "^7.0.15",
    "typescript": "^5.4.0"
  }
}
```

- [ ] **Step 2: Re-run install to refresh `bun.lock`**

Run: `bun install`
Expected: success; `bun.lock` updated to reflect `llm-events@0.2.0` in the workspace graph.

- [ ] **Step 3: Run plugin tests once more**

Run: `bun test plugins/llm-events/`
Expected: PASS, 15 tests.

- [ ] **Step 4: Commit**

```bash
git add plugins/llm-events/package.json bun.lock
git commit -m "chore(llm-events): bump to 0.2.0 for service-interface exports"
```

---

## Task 14: Publish `llm-events@0.2.0` to the marketplace catalog

Append the new version entry alongside (not replacing) `0.1.0`, so existing harness pins keep working until they are migrated.

**Files:**
- Modify: `.kaizen/marketplace.json`

- [ ] **Step 1: Inspect current entry**

The existing entry in `.kaizen/marketplace.json` is:

```json
{
  "kind": "plugin",
  "name": "llm-events",
  "description": "Event vocabulary and shared types for the openai-compatible harness.",
  "categories": ["events"],
  "versions": [{ "version": "0.1.0", "source": { "type": "file", "path": "plugins/llm-events" } }]
}
```

- [ ] **Step 2: Replace the entry with the multi-version form**

Edit the `llm-events` entry in `.kaizen/marketplace.json` to:

```json
{
  "kind": "plugin",
  "name": "llm-events",
  "description": "Event vocabulary and shared types for the openai-compatible harness.",
  "categories": ["events"],
  "versions": [
    { "version": "0.2.0", "source": { "type": "file", "path": "plugins/llm-events" } },
    { "version": "0.1.0", "source": { "type": "file", "path": "plugins/llm-events" } }
  ]
}
```

The catalog declares `0.2.0` first (newest); `0.1.0` is retained so any consumer that already pinned it does not break before migration.

- [ ] **Step 3: Validate the JSON parses**

Run: `bun -e "console.log(Object.keys(JSON.parse(require('fs').readFileSync('.kaizen/marketplace.json','utf8'))))"`
Expected: prints `[ "version", "name", "description", "url", "entries" ]`. (If the JSON is malformed the command exits non-zero.)

- [ ] **Step 4: Commit**

```bash
git add .kaizen/marketplace.json
git commit -m "chore(marketplace): publish llm-events@0.2.0"
```

---

## Task 15: Final verification — Tier 0 acceptance criteria

Walk through Spec 0's "Acceptance criteria for Tier 0" list and confirm each item one last time. No code changes; this is a checklist gate before declaring Tier 0 complete.

**Files:** none modified.

- [ ] **Step 1: Build + tests pass**

Run: `bun test plugins/llm-events/ && bun --bun tsc --noEmit -p plugins/llm-events/tsconfig.json plugins/llm-events/index.ts plugins/llm-events/public.d.ts plugins/llm-events/index.test.ts plugins/llm-events/test/acceptance-imports.test.ts`
Expected: 15 tests pass, zero diagnostics.

- [ ] **Step 2: Verify the import set named in Spec 0 acceptance criteria**

Run: `bun test plugins/llm-events/test/acceptance-imports.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 3: Verify marketplace entry points at the new version**

Run: `bun -e "const e=JSON.parse(require('fs').readFileSync('.kaizen/marketplace.json','utf8')).entries.find(x=>x.name==='llm-events'); console.log(e.versions[0].version)"`
Expected: prints `0.2.0`.

- [ ] **Step 4: Confirm dependent plugin (`openai-llm`) still builds**

Run: `bun test plugins/openai-llm/`
Expected: PASS (whatever count the existing suite currently reports).

- [ ] **Step 5: No commit**

If any of Steps 1–4 fail, halt and address the underlying cause; do not paper over with type assertions or `any`. The propagation rule in Spec 0 §"Spec 0 is the source of truth" applies — if the failure surfaces a contract gap, fix the spec first, then this plan.

---

## Notes for downstream specs

- **Adding new shared types later.** Any future cross-plugin type follows the same path: append to `public.d.ts`, add a type-only test under `plugins/llm-events/test/`, bump minor, update marketplace. No code in `index.ts` changes for type-only additions.
- **Adding new event names later.** Append to `VOCAB` (and the `Vocab` interface), grow the runtime "complete vocabulary" assertion in `index.test.ts`, bump minor, update marketplace.
- **Removing or renaming any of the above.** Major-version bump (`1.0.0`); coordinate with every Tier 1+ spec via the propagation rule before merging.
