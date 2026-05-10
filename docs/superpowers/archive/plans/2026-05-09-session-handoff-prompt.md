# Autonomous Session Handoff with Seeded Prompt — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the LLM call `session:new({prompt, autostart})` to archive the current session, mint a fresh one seeded with a starter prompt, and (by default) immediately run inference on it. Implements `docs/superpowers/specs/2026-05-09-session-handoff-prompt-design.md`.

**Architecture:** `llm-session-manager` archives + creates + seeds (writing the seeded user turn directly into the new snapshot) + emits a new `session:handoff` event. The driver subscribes and, when `autostart=true`, runs a turn against the new active session whose snapshot tail is the pending seeded user turn. The TUI subscribes for badge rendering and (when `autostart=false`) draft-buffer prefill. Other plugins (memory, skills, telemetry) can subscribe to the same event without further coordination.

**Tech Stack:** TypeScript, Bun (test + bundler), Kaizen plugin runtime, existing `sessions:store` service.

**Existing event reconciliation:** The pre-existing event is `session:active-changed` (not `session:switched` as the spec wrote). This plan uses the actual name. `session:active-changed` continues firing on every active-session change; `session:handoff` is strictly additive and fires only when a prompt is provided.

**Decision (resolved during plan write):** The seeded user turn is written to the new session's snapshot **by `llm-session-manager` before the handoff event fires**. The driver, on `autostart=true`, invokes a new `runConversation` mode that infers against the current snapshot tail (no `userMessage` provided). This matches the spec's "Snapshot starts with one message" wording and avoids racing the snapshot write against the first inference.

---

## File Map

| File | Responsibility | Change |
|---|---|---|
| `plugins/llm-events/public.d.ts` | Cross-plugin types | Add `meta?: Record<string, unknown>` to `ChatMessage`; add `RunConversationInput.userMessage` may be omitted |
| `plugins/llm-events/index.ts` | VOCAB owner | Add `SESSION_HANDOFF: "session:handoff"` |
| `plugins/llm-events/index.test.ts` | VOCAB tests | Cover new entry + meta type probe |
| `plugins/llm-session-manager/commands.ts` | Command surface | Extend `clearSession` to accept `{prompt?, autostart?}`; seed new session; emit `session:handoff` |
| `plugins/llm-session-manager/tools.ts` | Tool schema | Extend `session:new` params (prompt, autostart) |
| `plugins/llm-session-manager/slash.ts` | Slash registration | Parse `<text>` and `--draft` for `/session:new` and `/clear` |
| `plugins/llm-session-manager/index.ts` | Plugin manifest | Add `session:handoff` to `permissions.events.publish` (if used) |
| `plugins/llm-session-manager/test/commands.test.ts` (new) | Unit tests | Validation matrix + handoff event payload |
| `plugins/llm-session-manager/test/handoff.integration.test.ts` (new) | Integration | End-to-end ordering: archive → seed → switch → emit |
| `plugins/llm-driver/loop.ts` | runConversation | Allow `userMessage` omission; when absent, infer against snapshot tail |
| `plugins/llm-driver/public.d.ts` | RunConversationInput type | Make `userMessage` optional |
| `plugins/llm-driver/index.ts` | Plugin lifecycle | Subscribe to `session:handoff`; on `autostart=true` switch active session and dispatch a turn |
| `plugins/llm-driver/test/integration.test.ts` | Driver integration | Add handoff-autostart case |
| `plugins/llm-tui/index.tsx` (or relevant ui module) | Subscriptions | Subscribe to `session:handoff`; when `autostart=false`, prefill input buffer |
| `plugins/llm-tui/ui/<message-renderer>.tsx` | Message rendering | Render `[handoff from <fromId>]` badge when `message.meta?.handoff` is set |
| `plugins/llm-tui/integration.test.ts` | TUI integration | Badge + draft-prefill cases |

---

## Task 1: Add `meta` field to `ChatMessage`

**Files:**
- Modify: `plugins/llm-events/public.d.ts:51-57`
- Modify: `plugins/llm-events/index.test.ts`
- Modify: `plugins/llm-events/package.json` (minor version bump)

- [ ] **Step 1: Add structural test for `meta` field**

In `plugins/llm-events/index.test.ts`, find the `ChatMessage` structural probe (search for `role: "user"` or `ChatMessage` type assertion). Add:

```ts
test("ChatMessage supports optional meta", () => {
  const m: ChatMessage = {
    role: "user",
    content: "hi",
    meta: { handoff: { from: "abc" } },
  };
  expect(m.meta?.handoff).toBeDefined();
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
cd plugins/llm-events && bun test
```
Expected: TS error or failing test on `meta` not being a known property.

- [ ] **Step 3: Add `meta` to `ChatMessage`**

In `plugins/llm-events/public.d.ts:51-57`, replace:

```ts
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
}
```

with:

```ts
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
  /**
   * Optional, plugin-defined metadata about the message. Persisted with the
   * message in session snapshots. Reserved keys: `handoff` (set by
   * llm-session-manager when a session was seeded via `session:new` with a
   * prompt; payload is `{ from: <SessionId> }`).
   */
  meta?: Record<string, unknown>;
}
```

- [ ] **Step 4: Run tests, verify pass**

```bash
cd plugins/llm-events && bun test
```
Expected: PASS.

- [ ] **Step 5: Bump minor version**

Edit `plugins/llm-events/package.json` — bump the minor version (e.g., `0.2.0` → `0.3.0`). Per the plugin's CLAUDE.md, public-surface changes require a minor bump.

- [ ] **Step 6: Commit**

```bash
git add plugins/llm-events/public.d.ts plugins/llm-events/index.test.ts plugins/llm-events/package.json
git commit -m "feat(llm-events): add optional meta field to ChatMessage"
```

---

## Task 2: Add `SESSION_HANDOFF` to VOCAB

**Files:**
- Modify: `plugins/llm-events/index.ts`
- Modify: `plugins/llm-events/public.d.ts` (Vocab interface)
- Modify: `plugins/llm-events/index.test.ts`

- [ ] **Step 1: Add failing test for VOCAB entry**

In `plugins/llm-events/index.test.ts`, locate the `expected` set in the "VOCAB contains every Spec 0 event name" test. Add `"session:handoff"` to that set. Also add a spot-check assertion in the appropriate session-area test:

```ts
test("VOCAB.SESSION_HANDOFF is exposed", () => {
  expect(VOCAB.SESSION_HANDOFF).toBe("session:handoff");
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
cd plugins/llm-events && bun test
```
Expected: FAIL — `SESSION_HANDOFF` not on VOCAB.

- [ ] **Step 3: Add VOCAB entry**

In `plugins/llm-events/index.ts`, find the `VOCAB` object literal and add (preserving existing ordering near other `session:*` entries):

```ts
SESSION_HANDOFF: "session:handoff",
```

- [ ] **Step 4: Add typed key in Vocab interface**

In `plugins/llm-events/public.d.ts`, find the `Vocab` interface and add (near other `session:*` keys):

```ts
readonly SESSION_HANDOFF: "session:handoff";
```

- [ ] **Step 5: Run tests, verify pass**

```bash
cd plugins/llm-events && bun test
```
Expected: PASS (including the freeze test and structural probes).

- [ ] **Step 6: Commit**

```bash
git add plugins/llm-events/index.ts plugins/llm-events/public.d.ts plugins/llm-events/index.test.ts
git commit -m "feat(llm-events): add session:handoff to VOCAB"
```

---

## Task 3: Validation tests for `clearSession` parameter matrix

**Files:**
- Create: `plugins/llm-session-manager/test/commands.test.ts`

- [ ] **Step 1: Write failing validation tests**

Create `plugins/llm-session-manager/test/commands.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { makeCommands } from "../commands.ts";

function makeFakeStore() {
  let counter = 0;
  const messages: any[] = [];
  return {
    create: async () => ({ id: `s${++counter}`, alias: null, messages: [] } as any),
    beginTurn: () => ({
      turnId: "t1",
      append: (m: any) => messages.push(m),
      commit: async () => {},
      rollback: async () => {},
    }),
    _messages: messages,
  } as any;
}

function makeCmds(activeId: string | null = "s0") {
  const events: { event: string; payload: any }[] = [];
  const store = makeFakeStore();
  const cmds = makeCommands({
    store,
    emit: async (event, payload) => { events.push({ event, payload }); return []; },
    getActiveSessionId: () => activeId,
  });
  return { cmds, events, store };
}

describe("clearSession validation", () => {
  test("no prompt, no autostart: backward-compat (no handoff event)", async () => {
    const { cmds, events } = makeCmds();
    await cmds.clearSession();
    expect(events.find(e => e.event === "session:handoff")).toBeUndefined();
    expect(events.find(e => e.event === "session:active-changed")).toBeDefined();
  });

  test("prompt + autostart=true: emits handoff with autostart=true", async () => {
    const { cmds, events } = makeCmds();
    await cmds.clearSession({ prompt: "continue work on X", autostart: true });
    const handoff = events.find(e => e.event === "session:handoff");
    expect(handoff).toBeDefined();
    expect(handoff!.payload.autostart).toBe(true);
    expect(handoff!.payload.prompt).toBe("continue work on X");
  });

  test("prompt only: defaults autostart to true", async () => {
    const { cmds, events } = makeCmds();
    await cmds.clearSession({ prompt: "continue" });
    const handoff = events.find(e => e.event === "session:handoff");
    expect(handoff!.payload.autostart).toBe(true);
  });

  test("prompt + autostart=false: emits handoff with autostart=false", async () => {
    const { cmds, events } = makeCmds();
    await cmds.clearSession({ prompt: "draft this", autostart: false });
    const handoff = events.find(e => e.event === "session:handoff");
    expect(handoff!.payload.autostart).toBe(false);
  });

  test("autostart=true with no prompt: rejects", async () => {
    const { cmds } = makeCmds();
    await expect(cmds.clearSession({ autostart: true })).rejects.toThrow(/prompt/i);
  });

  test("autostart=false with no prompt: rejects", async () => {
    const { cmds } = makeCmds();
    await expect(cmds.clearSession({ autostart: false })).rejects.toThrow(/prompt/i);
  });

  test("empty/whitespace prompt: rejects", async () => {
    const { cmds } = makeCmds();
    await expect(cmds.clearSession({ prompt: "   " })).rejects.toThrow(/non-empty/i);
  });

  test("active session is a child session: rejects handoff", async () => {
    const { cmds } = makeCmds("parent/child");
    await expect(cmds.clearSession({ prompt: "x" })).rejects.toThrow(/top-level/i);
  });

  test("seeded user turn lands in new snapshot with meta.handoff.from", async () => {
    const { cmds, store } = makeCmds("oldId");
    await cmds.clearSession({ prompt: "hello successor" });
    const seeded = store._messages[0];
    expect(seeded.role).toBe("user");
    expect(seeded.content).toBe("hello successor");
    expect(seeded.meta?.handoff?.from).toBe("oldId");
  });

  test("event ordering: active-changed fires before handoff", async () => {
    const { cmds, events } = makeCmds();
    await cmds.clearSession({ prompt: "x" });
    const ac = events.findIndex(e => e.event === "session:active-changed");
    const ho = events.findIndex(e => e.event === "session:handoff");
    expect(ac).toBeGreaterThanOrEqual(0);
    expect(ho).toBeGreaterThan(ac);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
cd plugins/llm-session-manager && bun test test/commands.test.ts
```
Expected: All tests fail (current `clearSession` takes no args, returns `{from, to, alias}`, no validation).

- [ ] **Step 3: No commit yet** — implementation in Task 4 will make these pass.

---

## Task 4: Extend `clearSession` with prompt seeding + handoff event

**Files:**
- Modify: `plugins/llm-session-manager/commands.ts`

- [ ] **Step 1: Replace `clearSession` signature and body**

In `plugins/llm-session-manager/commands.ts`, replace lines 9-13 (the `ClearResult` interface) and lines 23-31 (the `clearSession` function body) with:

```ts
export interface ClearResult {
  from: string | null;
  to: string;
  alias: string | null;
  seeded: boolean;
}

export interface ClearOptions {
  prompt?: string;
  autostart?: boolean;
}
```

And update the `CommandsApi` interface signature to:

```ts
clearSession(opts?: ClearOptions): Promise<ClearResult>;
```

Replace the `clearSession` implementation:

```ts
async function clearSession(opts: ClearOptions = {}): Promise<ClearResult> {
  const hasPrompt = typeof opts.prompt === "string" && opts.prompt.trim().length > 0;
  const explicitPromptArg = "prompt" in opts;
  const explicitAutostart = "autostart" in opts;

  if (explicitAutostart && !hasPrompt) {
    throw new Error("session:new: autostart requires a non-empty prompt");
  }
  if (explicitPromptArg && !hasPrompt) {
    throw new Error("session:new: prompt must be non-empty");
  }

  const from = deps.getActiveSessionId();
  if (hasPrompt && from && from.includes("/")) {
    throw new Error("session:new: handoff is supported only for top-level sessions");
  }

  const next = await deps.store.create({});
  const alias = next.alias ?? null;

  let seeded = false;
  if (hasPrompt) {
    const turn = deps.store.beginTurn(next.id, `seed-${next.id}`);
    turn.append({
      role: "user",
      content: opts.prompt!,
      meta: { handoff: { from } },
    });
    await turn.commit();
    seeded = true;
  }

  await deps.emit("session:active-changed", { from, to: next.id, alias });
  await deps.emit("conversation:cleared", { from, to: next.id });

  if (hasPrompt) {
    const autostart = opts.autostart !== false; // default true
    await deps.emit("session:handoff", {
      from,
      to: next.id,
      prompt: opts.prompt!,
      autostart,
    });
  }

  return { from, to: next.id, alias, seeded };
}
```

- [ ] **Step 2: Run tests, verify all pass**

```bash
cd plugins/llm-session-manager && bun test test/commands.test.ts
```
Expected: PASS (all 10 tests).

- [ ] **Step 3: Run full plugin test suite to confirm no regressions**

```bash
cd plugins/llm-session-manager && bun test
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add plugins/llm-session-manager/commands.ts plugins/llm-session-manager/test/commands.test.ts
git commit -m "feat(llm-session-manager): seed new session with handoff prompt"
```

---

## Task 5: Tool schema for `session:new` with prompt/autostart

**Files:**
- Modify: `plugins/llm-session-manager/tools.ts:16-23`
- Modify: `plugins/llm-session-manager/test/tools.test.ts`

- [ ] **Step 1: Write failing tool schema test**

In `plugins/llm-session-manager/test/tools.test.ts`, add:

```ts
test("session:new tool schema accepts prompt + autostart", () => {
  const registered: any[] = [];
  const fakeReg = {
    register: (schema: any, handler: any) => { registered.push({ schema, handler }); return () => {}; },
  };
  const fakeCmds: any = {
    clearSession: async (opts: any) => ({ from: null, to: "x", alias: null, seeded: !!opts?.prompt }),
  };
  registerToolCommands(fakeReg as any, fakeCmds);
  const schema = registered.find(r => r.schema.name === "session:new").schema;
  expect(schema.parameters.properties.prompt).toBeDefined();
  expect(schema.parameters.properties.autostart).toBeDefined();
  expect(schema.parameters.additionalProperties).toBe(false);
});

test("session:new tool forwards args to clearSession", async () => {
  let captured: any = null;
  const fakeReg = { register: (s: any, h: any) => { if (s.name === "session:new") (fakeReg as any).handler = h; return () => {}; } };
  const fakeCmds: any = {
    clearSession: async (opts: any) => { captured = opts; return { from: null, to: "x", alias: null, seeded: !!opts?.prompt }; },
  };
  registerToolCommands(fakeReg as any, fakeCmds);
  await (fakeReg as any).handler({ prompt: "go", autostart: false }, { signal: new AbortController().signal, callId: "c1", log: () => {} });
  expect(captured).toEqual({ prompt: "go", autostart: false });
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
cd plugins/llm-session-manager && bun test test/tools.test.ts
```
Expected: FAIL — schema lacks new properties; handler ignores args.

- [ ] **Step 3: Update tool registration**

In `plugins/llm-session-manager/tools.ts:16-23`, replace the `session:new` registration with:

```ts
offs.push(tools.register(
  {
    name: "session:new",
    description:
      "Archive the current session and start a fresh one. Optionally seed the new session with a starter prompt — useful when context has grown bloated and you want to continue work in a clean session. With autostart=true (default), the new session immediately runs inference on the seeded prompt; with autostart=false, the prompt lands in the user input as a draft for the human to review. Returns ids of previous (from) and new (to) sessions and a seeded flag.",
    parameters: {
      type: "object",
      properties: {
        prompt:    { type: "string",  description: "Starter prompt for the new session. The new LLM sees this as its first user turn." },
        autostart: { type: "boolean", description: "If true (default), inference begins immediately in the new session. If false, the prompt is queued as a draft for the human to review." },
      },
      additionalProperties: false,
    } as any,
  },
  async (args: any) => cmds.clearSession({
    prompt: typeof args?.prompt === "string" ? args.prompt : undefined,
    autostart: typeof args?.autostart === "boolean" ? args.autostart : undefined,
  }),
));
```

- [ ] **Step 4: Run tests, verify pass**

```bash
cd plugins/llm-session-manager && bun test
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-session-manager/tools.ts plugins/llm-session-manager/test/tools.test.ts
git commit -m "feat(llm-session-manager): session:new tool accepts prompt and autostart"
```

---

## Task 6: Slash command `/session:new` accepts prompt + `--draft`

**Files:**
- Modify: `plugins/llm-session-manager/slash.ts:28-40`
- Modify: `plugins/llm-session-manager/test/slash.test.ts`

- [ ] **Step 1: Write failing slash tests**

In `plugins/llm-session-manager/test/slash.test.ts`, add:

```ts
test("/session:new with no args: bare archive+switch", async () => {
  let captured: any = "no-call";
  const cmds: any = { clearSession: async (o: any) => { captured = o; return { from: null, to: "x", alias: null, seeded: false }; } };
  const handlers: Record<string, any> = {};
  const slash = { register: (m: any, h: any) => { handlers[m.name] = h; return () => {}; } };
  registerSlashCommands(slash as any, cmds);
  await handlers["session:new"]({ args: "", print: async () => {} });
  expect(captured).toEqual({});
});

test("/session:new <text>: prompt + autostart=true", async () => {
  let captured: any = null;
  const cmds: any = { clearSession: async (o: any) => { captured = o; return { from: null, to: "x", alias: null, seeded: true }; } };
  const handlers: Record<string, any> = {};
  const slash = { register: (m: any, h: any) => { handlers[m.name] = h; return () => {}; } };
  registerSlashCommands(slash as any, cmds);
  await handlers["session:new"]({ args: "continue the refactor", print: async () => {} });
  expect(captured).toEqual({ prompt: "continue the refactor", autostart: true });
});

test("/session:new --draft <text>: prompt + autostart=false", async () => {
  let captured: any = null;
  const cmds: any = { clearSession: async (o: any) => { captured = o; return { from: null, to: "x", alias: null, seeded: true }; } };
  const handlers: Record<string, any> = {};
  const slash = { register: (m: any, h: any) => { handlers[m.name] = h; return () => {}; } };
  registerSlashCommands(slash as any, cmds);
  await handlers["session:new"]({ args: "--draft continue the refactor", print: async () => {} });
  expect(captured).toEqual({ prompt: "continue the refactor", autostart: false });
});
```

- [ ] **Step 2: Run tests, verify failure**

```bash
cd plugins/llm-session-manager && bun test test/slash.test.ts
```
Expected: FAIL — handler currently ignores `ctx.args`.

- [ ] **Step 3: Update slash handler**

In `plugins/llm-session-manager/slash.ts:28-40`, replace the `newSessionHandler` and the two `slash.register` calls with:

```ts
const newSessionHandler = async (ctx: SlashCommandContextLike) => {
  const raw = ctx.args.trim();
  const opts: { prompt?: string; autostart?: boolean } = {};
  if (raw) {
    let text = raw;
    if (text.startsWith("--draft")) {
      opts.autostart = false;
      text = text.slice("--draft".length).trim();
    } else {
      opts.autostart = true;
    }
    if (!text) {
      await ctx.print("Usage: /session:new [--draft] <prompt-text>");
      return;
    }
    opts.prompt = text;
  }
  const r = await cmds.clearSession(opts);
  if (r.seeded) {
    await ctx.print(`Active session: ${r.to} (seeded${opts.autostart === false ? "; draft" : ""})`);
  } else {
    await ctx.print(`Active session: ${r.to}`);
  }
};

offs.push(slash.register(
  { name: "clear", description: "Archive current session and start a fresh one", source: "builtin", usage: "[--draft] [prompt]" },
  newSessionHandler,
));
offs.push(slash.register(
  { name: "session:new", description: "Create and switch to a new top-level session, optionally seeded with a starter prompt", source: "plugin", usage: "[--draft] [prompt]" },
  newSessionHandler,
));
```

- [ ] **Step 4: Run tests, verify pass**

```bash
cd plugins/llm-session-manager && bun test
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-session-manager/slash.ts plugins/llm-session-manager/test/slash.test.ts
git commit -m "feat(llm-session-manager): /session:new accepts prompt and --draft"
```

---

## Task 7: Integration test for handoff event ordering

**Files:**
- Create: `plugins/llm-session-manager/test/handoff.integration.test.ts`

- [ ] **Step 1: Write end-to-end ordering test**

```ts
import { describe, test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeStore } from "../store.ts";
import { makeCommands } from "../commands.ts";

describe("session:handoff integration", () => {
  test("archive → seed → switch → handoff event, in order", async () => {
    const sessionsBase = mkdtempSync(join(tmpdir(), "sm-handoff-"));
    const events: { event: string; payload: any; t: number }[] = [];
    let counter = 0;
    const store = makeStore({
      sessionsBase,
      harnessKey: "test",
      pluginFingerprint: ["test@0"],
      now: () => ++counter,
      newUuid: () => `uuid-${counter}`,
      log: () => {},
      emit: async (event, payload) => { events.push({ event, payload, t: ++counter }); return []; },
    });

    const initial = await store.create({});
    let activeId: string | null = initial.id;
    const cmds = makeCommands({
      store,
      emit: async (event, payload) => { events.push({ event, payload, t: ++counter }); return []; },
      getActiveSessionId: () => activeId,
    });

    const result = await cmds.clearSession({ prompt: "carry on", autostart: true });
    activeId = result.to;

    // Snapshot of new session contains the seeded user message with meta
    const messages = await store.getMessages(result.to);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toBe("carry on");
    expect((messages[0] as any).meta?.handoff?.from).toBe(initial.id);

    // Event order: session:created (new) → session:active-changed → conversation:cleared → session:handoff
    const names = events.map(e => e.event);
    const created = names.lastIndexOf("session:created");
    const ac = names.lastIndexOf("session:active-changed");
    const cleared = names.lastIndexOf("conversation:cleared");
    const ho = names.lastIndexOf("session:handoff");
    expect(created).toBeGreaterThan(-1);
    expect(ac).toBeGreaterThan(created);
    expect(cleared).toBeGreaterThan(ac);
    expect(ho).toBeGreaterThan(cleared);

    // Handoff payload shape
    const handoff = events[ho];
    expect(handoff.payload).toEqual({
      from: initial.id,
      to: result.to,
      prompt: "carry on",
      autostart: true,
    });
  });

  test("autostart=false fires handoff with autostart=false", async () => {
    const sessionsBase = mkdtempSync(join(tmpdir(), "sm-handoff-"));
    const events: { event: string; payload: any }[] = [];
    let counter = 0;
    const store = makeStore({
      sessionsBase, harnessKey: "test", pluginFingerprint: ["test@0"],
      now: () => ++counter, newUuid: () => `uuid-${counter}`,
      log: () => {}, emit: async (e, p) => { events.push({ event: e, payload: p }); return []; },
    });
    const initial = await store.create({});
    let activeId: string | null = initial.id;
    const cmds = makeCommands({
      store,
      emit: async (e, p) => { events.push({ event: e, payload: p }); return []; },
      getActiveSessionId: () => activeId,
    });
    await cmds.clearSession({ prompt: "draft this", autostart: false });
    const ho = events.find(e => e.event === "session:handoff");
    expect(ho!.payload.autostart).toBe(false);
  });
});
```

- [ ] **Step 2: Run test, verify pass**

```bash
cd plugins/llm-session-manager && bun test test/handoff.integration.test.ts
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add plugins/llm-session-manager/test/handoff.integration.test.ts
git commit -m "test(llm-session-manager): handoff ordering and snapshot integration"
```

---

## Task 8: Allow `runConversation` to omit `userMessage`

**Files:**
- Modify: `plugins/llm-driver/public.d.ts`
- Modify: `plugins/llm-driver/loop.ts`
- Modify: `plugins/llm-driver/test/integration.test.ts`

- [ ] **Step 1: Inspect current `RunConversationInput`**

```bash
grep -n "RunConversationInput\|userMessage" plugins/llm-driver/public.d.ts plugins/llm-driver/loop.ts | head -20
```

- [ ] **Step 2: Write failing test**

In `plugins/llm-driver/test/integration.test.ts` (or alongside existing tests, following local fakery patterns), add:

```ts
test("runConversation without userMessage infers against snapshot tail", async () => {
  // Reuse the existing test harness factories. The session has been pre-seeded
  // with one user message; runConversation should produce an assistant turn
  // without appending a fresh user message.
  const { runConversation, deps, sessions, sessionId } = await makeHarness();
  await sessions.beginTurn(sessionId, "seed").let((t: any) => { t.append({ role: "user", content: "seeded prompt" }); return t.commit(); });

  const out = await runConversation({ sessionId }, deps);
  expect(out.finalMessage.role).toBe("assistant");
  const all = await sessions.getMessages(sessionId);
  expect(all.filter((m: any) => m.role === "user")).toHaveLength(1);
});
```

(Adapt to the integration-test's actual harness API; the principle is: pre-seed a user message, call `runConversation` without `userMessage`, assert no duplicate user message and an assistant reply was produced.)

- [ ] **Step 3: Run test, verify failure**

```bash
cd plugins/llm-driver && bun test
```
Expected: FAIL — `userMessage` currently required.

- [ ] **Step 4: Make `userMessage` optional in type**

In `plugins/llm-driver/public.d.ts`, find `RunConversationInput`. Change:

```ts
userMessage: string;
```

to:

```ts
/**
 * The user message to append before inference. When omitted, runConversation
 * infers against the current snapshot tail (which must already end with a
 * user turn, e.g. one seeded by session:handoff).
 */
userMessage?: string;
```

- [ ] **Step 5: Update `loop.ts` to skip the user-append when omitted**

In `plugins/llm-driver/loop.ts`, find where the input's `userMessage` is appended to the turn handle (search for `userMessage` inside `runConversation`). Wrap the append in a guard:

```ts
if (typeof input.userMessage === "string") {
  turnHandle.append({ role: "user", content: input.userMessage });
}
```

If the flow uses `userMessage` in any other places (system-prompt assembly, telemetry), make those usages tolerate `undefined` (default to reading the last user message from the snapshot via `sessions.getMessages(sessionId)`).

If `runConversation` validates `input.userMessage` non-empty up front, replace that with: when `userMessage` is provided, require non-empty; when omitted, require that `getMessages(sessionId)` ends with a `role === "user"` message (otherwise throw `"runConversation: no userMessage and no pending user turn at snapshot tail"`).

- [ ] **Step 6: Run tests, verify pass**

```bash
cd plugins/llm-driver && bun test
```
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add plugins/llm-driver/public.d.ts plugins/llm-driver/loop.ts plugins/llm-driver/test/integration.test.ts
git commit -m "feat(llm-driver): runConversation may infer against pending user tail"
```

---

## Task 9: Driver subscribes to `session:handoff` and autoruns

**Files:**
- Modify: `plugins/llm-driver/index.ts` (subscribe section, around lines 107-122)
- Modify: `plugins/llm-driver/test/integration.test.ts`

- [ ] **Step 1: Write failing integration test**

```ts
test("driver runs a turn on session:handoff with autostart=true", async () => {
  const { ctx, sessions, runs } = await makeDriverHarness();
  // Simulate session-manager emitting handoff after seeding
  const newId = (await sessions.create({})).id;
  const t = sessions.beginTurn(newId, "seed");
  t.append({ role: "user", content: "do the thing", meta: { handoff: { from: "old" } } });
  await t.commit();
  await ctx.emit("session:active-changed", { from: "old", to: newId, alias: null });
  await ctx.emit("session:handoff", { from: "old", to: newId, prompt: "do the thing", autostart: true });

  // Wait one tick for subscriber to dispatch
  await new Promise(r => setTimeout(r, 10));

  expect(runs.length).toBe(1);
  expect(runs[0].sessionId).toBe(newId);
  expect(runs[0].userMessage).toBeUndefined();
});

test("driver no-ops on session:handoff with autostart=false", async () => {
  const { ctx, sessions, runs } = await makeDriverHarness();
  const newId = (await sessions.create({})).id;
  await ctx.emit("session:handoff", { from: "old", to: newId, prompt: "draft", autostart: false });
  await new Promise(r => setTimeout(r, 10));
  expect(runs.length).toBe(0);
});
```

(`makeDriverHarness` is the existing integration-test factory. If it doesn't yet expose a way to capture `runConversation` calls, add a minimal `runs: any[]` capture spy.)

- [ ] **Step 2: Run, verify fail**

```bash
cd plugins/llm-driver && bun test
```

- [ ] **Step 3: Add subscriber in `setup()`**

In `plugins/llm-driver/index.ts`, immediately after the existing `session:active-changed` subscription (around line 113), add:

```ts
ctx.on("session:handoff", async (payload: any) => {
  if (!payload || payload.autostart !== true) return;
  if (typeof payload.to !== "string") return;
  // session:active-changed has already updated state.activeSessionId.
  // Dispatch a turn against the new session; the seeded user message is
  // already at the snapshot tail.
  try {
    if (!buildDeps) return;
    await runConversation({ sessionId: payload.to }, buildDeps());
  } catch (err) {
    ctx.log(`session:handoff autostart failed: ${(err as any)?.message ?? String(err)}`);
  }
});
```

(Import `runConversation` at the top of `index.ts` if not already imported; check the existing import block.)

**Note on REPL interaction:** The interactive `start()` loop is awaiting `ui.readInput()` when handoff fires. The subscriber-driven turn runs to completion in parallel; then `ui.readInput()` resolves on the user's next keystroke as normal. There is no need to short-circuit the REPL loop because nothing in the REPL is gating the new session's first turn — the subscriber owns it.

If both the REPL and the subscriber attempt to emit `turn:start` for the same session concurrently in some edge case, the existing `currentTurn` guard in `runConversation` handles single-flight per session-id. If that guard does not exist, add a check at the top of the subscriber: `if (state.currentTurn) return;` (skip — let user retry).

- [ ] **Step 4: Run tests, verify pass**

```bash
cd plugins/llm-driver && bun test
```

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-driver/index.ts plugins/llm-driver/test/integration.test.ts
git commit -m "feat(llm-driver): autostart turn on session:handoff"
```

---

## Task 10: TUI subscribes to `session:handoff` for badge + draft

**Files:**
- Modify: `plugins/llm-tui/index.tsx` (subscriptions registered in `setup()`)
- Modify: TUI message renderer (file containing the user-message Ink/Box rendering — locate via `grep`)
- Modify: `plugins/llm-tui/integration.test.ts`

- [ ] **Step 1: Locate the message renderer file**

```bash
grep -rn "role.*user\|<Text\|MessageRow\|renderMessage" plugins/llm-tui/ui/ plugins/llm-tui/index.tsx | head -20
```

Note the file/line responsible for rendering a single user message — this is where the badge will live.

- [ ] **Step 2: Write failing renderer test**

In `plugins/llm-tui/integration.test.ts` (or a new `plugins/llm-tui/ui/<file>.test.tsx`), add:

```ts
test("user message with meta.handoff renders a badge", () => {
  const msg = { role: "user", content: "carry on", meta: { handoff: { from: "abc123" } } };
  const out = renderMessageToString(msg); // helper from the test file's existing renderer harness
  expect(out).toMatch(/handoff from abc123/);
});

test("user message without meta.handoff has no badge", () => {
  const msg = { role: "user", content: "hi" };
  const out = renderMessageToString(msg);
  expect(out).not.toMatch(/handoff/i);
});
```

- [ ] **Step 3: Run, verify fail**

```bash
cd plugins/llm-tui && bun test
```

- [ ] **Step 4: Add badge to user-message renderer**

In the renderer file located in Step 1, before the message content is printed (only when `role === "user"`), conditionally render the badge:

```tsx
{message.meta?.handoff && typeof (message.meta.handoff as any).from === "string" && (
  <Text dimColor>{`[handoff from ${(message.meta.handoff as any).from}]`} </Text>
)}
```

(Style with the existing `dimColor` or theme idiom; do not add a new theme key unless one already exists for this purpose.)

- [ ] **Step 5: Add subscriber for autostart=false draft prefill**

In `plugins/llm-tui/index.tsx`, in `setup()` alongside other `ctx.on(...)` calls, add:

```ts
ctx.on("session:handoff", (payload: any) => {
  if (!payload || payload.autostart === true) return;
  if (typeof payload.prompt !== "string") return;
  // Defer to start() time when moduleUi is available.
  pendingDraft = payload.prompt;
});
```

Add the `pendingDraft: string | null = null` module-scope variable (reset in `setup()`).

In `start()`, after `moduleUi` is resolved and at the top of the REPL loop, before `await ui.readInput()`, drain the pending draft:

```ts
if (pendingDraft) {
  ui.setInputDraft(pendingDraft);
  pendingDraft = null;
}
```

If the UI channel does not yet expose `setInputDraft`, add it to the `UiChannel` interface in `plugins/llm-tui/public.d.ts` and implement it in the input component (the input component owns its buffer state; thread the call through the channel exactly like `writeNotice`).

- [ ] **Step 6: Add test for draft prefill**

```ts
test("session:handoff with autostart=false prefills the input buffer", async () => {
  const { ctx, ui } = await makeTuiHarness();
  await ctx.emit("session:handoff", { from: "old", to: "new", prompt: "review this", autostart: false });
  // Drive one REPL tick
  ui.tick();
  expect(ui.getInputBuffer()).toBe("review this");
});
```

- [ ] **Step 7: Run tests, verify pass**

```bash
cd plugins/llm-tui && bun test
```

- [ ] **Step 8: Commit**

```bash
git add plugins/llm-tui/
git commit -m "feat(llm-tui): handoff badge and draft prefill on session:handoff"
```

---

## Task 11: Update plugin permissions

**Files:**
- Modify: `plugins/llm-session-manager/index.ts` (permissions block)
- Modify: `plugins/llm-driver/index.ts` (permissions block)
- Modify: `plugins/llm-tui/index.tsx` (permissions block)

- [ ] **Step 1: Inspect current permissions blocks**

```bash
grep -n -A5 "permissions:\|events:" plugins/llm-session-manager/index.ts plugins/llm-driver/index.ts plugins/llm-tui/index.tsx | head -60
```

- [ ] **Step 2: Add publish/subscribe entries**

For `llm-session-manager`: ensure `permissions.events.publish` (if the runtime requires explicit publish declaration) includes `"session:handoff"`. If `publish` is not declared today, add it minimally, listing only the events this plugin emits beyond the existing `session:created`, `session:active-changed`, etc. If the runtime infers publish from `defineEvent`, no change is needed (verify by reading any other plugin's index for the publish convention).

For `llm-driver`: add `"session:handoff"` to `permissions.events.subscribe`.

For `llm-tui`: add `"session:handoff"` to `permissions.events.subscribe`.

- [ ] **Step 3: Run all three plugins' tests**

```bash
cd plugins/llm-session-manager && bun test
cd plugins/llm-driver && bun test
cd plugins/llm-tui && bun test
```
Expected: All PASS.

- [ ] **Step 4: Commit**

```bash
git add plugins/llm-session-manager/index.ts plugins/llm-driver/index.ts plugins/llm-tui/index.tsx
git commit -m "chore: declare session:handoff in plugin permissions"
```

---

## Task 12: Local deploy and end-to-end smoke test

**Files:** none — operational verification only.

- [ ] **Step 1: Bundle and copy each modified plugin**

Per each plugin's CLAUDE.md ("Local deploy"), run for `llm-events`, `llm-session-manager`, `llm-driver`, `llm-tui`:

```bash
PLUGIN=llm-events VERSION=0.3.0  # update VERSION per package.json after Task 1
cp -R plugins/$PLUGIN/. ~/.kaizen/marketplaces/official/plugins/$PLUGIN@$VERSION/
(cd ~/.kaizen/marketplaces/official/plugins/$PLUGIN@$VERSION \
  && bun build --target=bun --outfile=dist/index.js index.ts)
```

Repeat with `PLUGIN=llm-session-manager`, `PLUGIN=llm-driver`, `PLUGIN=llm-tui` and their respective installed versions (read from `~/.kaizen/marketplaces/official/plugins/` directory listing).

- [ ] **Step 2: Launch the openai-compatible harness**

```bash
kaizen run openai-compatible
```

- [ ] **Step 3: Smoke test — bare `/session:new`**

In the TUI: type `/session:new`. Expected: prints `Active session: <new-id>`, no inference fires.

- [ ] **Step 4: Smoke test — slash with prompt + autostart**

In the TUI: type `/session:new please summarize the architecture decisions in CLAUDE.md`. Expected: new session becomes active; the seeded prompt appears as a user message with `[handoff from <oldId>]` badge; the LLM begins generating an assistant reply automatically.

- [ ] **Step 5: Smoke test — `--draft`**

In the TUI: type `/session:new --draft please summarize the architecture decisions`. Expected: new session becomes active; input buffer is prefilled with the prompt; no inference fires until user submits.

- [ ] **Step 6: Smoke test — LLM tool call**

In an active session, prompt the LLM with: "Call session:new with a starter prompt to continue our discussion in a fresh session." Expected: LLM emits the `session:new` tool call with `prompt` and `autostart=true`; harness archives, switches, badges, autoruns the new turn.

- [ ] **Step 7: Validate snapshot on disk**

```bash
ls ~/.kaizen/sessions/<harness-key>/
cat ~/.kaizen/sessions/<harness-key>/<new-session-id>/snapshot.json | jq '.messages[0]'
```
Expected: the first message has `role: "user"`, `content: <the prompt>`, `meta.handoff.from: <old-session-id>`.

- [ ] **Step 8: Commit deploy notes (if any)**

If any per-plugin deploy fix was needed (e.g., a missed dependency), commit it now under `chore: …`.

---

## Self-Review Notes

**Spec coverage check:**
- API surface (`prompt`, `autostart`, return shape): Tasks 4, 5.
- Slash with text and `--draft`: Task 6.
- `session:handoff` event and payload shape: Tasks 2, 4, 7.
- Subscribers (driver, TUI, llm-events): Tasks 9, 10. (`llm-events` log is automatic via the existing trace-subscriber if it lists this event; if not, add to its subscriber list — covered implicitly by Task 11 if events plugin requires explicit subscription.)
- Snapshot seeded user turn with `meta.handoff`: Tasks 1, 4, 7.
- Badge rendering: Task 10.
- Autostart=true turn dispatch: Tasks 8, 9.
- Autostart=false draft prefill: Task 10.
- Validation matrix (every row): Task 3 (tests), Task 4 (impl).
- Child-session rejection: Task 3 (test), Task 4 (impl).
- Backward-compat zero-arg path: Tasks 3, 4.

**Placeholder scan:** Tasks 8 and 10 contain "(adapt to local harness factory)" notes — the implementer must inspect the existing `makeHarness` / `makeTuiHarness` to wire the spy. This is intentional; the plan supplies the assertion shape and required behavior, not the boilerplate of an in-flight test infra it cannot see. No `TBD`, no "implement later".

**Type consistency:** `meta.handoff.from: string` used consistently in Tasks 1, 4, 7, 10. `clearSession({prompt?, autostart?})` consistent in Tasks 3, 4, 5, 6. `session:handoff` payload `{from, to, prompt, autostart}` consistent in Tasks 4, 7, 9, 10.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-09-session-handoff-prompt.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
