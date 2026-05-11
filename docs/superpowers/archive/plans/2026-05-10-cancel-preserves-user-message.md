# Cancel Preserves User Message — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a turn is cancelled (Ctrl+C / `turn:cancel` → AbortError), preserve the user's original message and any completed assistant/tool roundtrips in the session snapshot. Drop only a trailing assistant message with unresolved `toolCalls`.

**Architecture:** Add `partialCommit()` to `TurnHandle` in `llm-session-manager/store.ts`. Branch the driver's catch on `AbortError`: call `partialCommit()` for aborts, keep `rollback()` for non-abort errors. `partialCommit()` drops a trailing `assistant` message with non-empty `toolCalls` then writes the snapshot via the same atomic path `commit()` uses; an empty post-trim buffer rolls back instead of writing.

**Tech Stack:** TypeScript, Bun (runtime + test runner), kaizen plugin framework.

**Spec:** `docs/superpowers/2026-05-10-cancel-preserves-user-message-design.md`

---

### Task 1: Extend `TurnHandle` interface with `partialCommit` (stub-only, keep all existing tests green)

**Files:**
- Modify: `plugins/llm-session-manager/store.ts:22-27` (interface) and `:210-243` (impl)
- Modify: `plugins/llm-driver/test/integration.test.ts:17-26`
- Modify: `plugins/llm-driver/test/system-prompt-integration.test.ts:14-23`
- Modify: `plugins/llm-driver/test/index.test.ts:48-60`
- Modify: `plugins/llm-driver/test/loop.test.ts:39-` (the `beginTurn` fake)
- Modify: `plugins/llm-session-manager/test/commands.test.ts:11` and `:61-65`
- Modify: `plugins/llm-session-manager/test/parity.test.ts:13`

- [ ] **Step 1: Add `partialCommit` to the `TurnHandle` interface**

In `plugins/llm-session-manager/store.ts`, change:

```ts
export interface TurnHandle {
  readonly turnId: string;
  append(msg: ChatMessage): void;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}
```

to:

```ts
export interface TurnHandle {
  readonly turnId: string;
  append(msg: ChatMessage): void;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  /**
   * Preserve the user message and any completed tool roundtrips; drop a trailing
   * assistant message whose toolCalls have no matching tool results.
   * If the post-trim buffer is empty, behave as rollback().
   */
  partialCommit(): Promise<void>;
}
```

- [ ] **Step 2: Add a stub `partialCommit` to the real handle in `beginTurn`**

In `plugins/llm-session-manager/store.ts:210-243`, inside the `const handle: TurnHandle = { ... }` object, add (next to `rollback`):

```ts
      async partialCommit() {
        throw new Error("partialCommit: not yet implemented");
      },
```

- [ ] **Step 3: Add stub `partialCommit` to every test fake that implements `TurnHandle`**

For each of the following six locations, add `partialCommit: async () => {}` next to the existing `rollback` entry:

`plugins/llm-driver/test/integration.test.ts` — inside the object returned at `:20`:
```ts
        commit: async () => { messages.set(id, [...(messages.get(id) ?? []), ...buffer]); open.delete(id); },
        rollback: async () => { open.delete(id); },
        partialCommit: async () => { open.delete(id); },
```
(Stub mirrors rollback here — these tests don't exercise partial-commit semantics yet; Task 4 adds a dedicated test.)

`plugins/llm-driver/test/system-prompt-integration.test.ts` — inside the handle at `:14-23`: add `partialCommit: async () => { open = null; },`

`plugins/llm-driver/test/index.test.ts` — inside the handle at `:48-60`: add `partialCommit: async () => { open.delete(id); },`

`plugins/llm-driver/test/loop.test.ts` — find every `beginTurn` fake (around `:39` and any others), add `partialCommit: async () => { /* no-op */ },` matching the existing `rollback` shape.

`plugins/llm-session-manager/test/commands.test.ts` — two places:
- `:11`: change `({ turnId, append: () => {}, commit: async () => {}, rollback: async () => {} })` to `({ turnId, append: () => {}, commit: async () => {}, rollback: async () => {}, partialCommit: async () => {} })`
- `:61-65`: add `partialCommit: async () => {},`

`plugins/llm-session-manager/test/parity.test.ts:13` — same one-line edit as `commands.test.ts:11`.

- [ ] **Step 4: Run both plugins' test suites; expect all green**

```bash
cd plugins/llm-session-manager && bun test
cd ../llm-driver && bun test
```

Expected: all tests pass. The stub on the real handle throws if called, but nothing calls it yet.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-session-manager/store.ts plugins/llm-session-manager/test plugins/llm-driver/test
git commit -m "session-manager: add partialCommit stub to TurnHandle"
```

---

### Task 2: TDD — failing unit tests for `partialCommit` semantics

**Files:**
- Modify: `plugins/llm-session-manager/test/store.test.ts`

- [ ] **Step 1: Add the test block at the end of the `describe("store", ...)` block in `plugins/llm-session-manager/test/store.test.ts`**

```ts
  test("partialCommit: empty buffer behaves as rollback", async () => {
    const { store } = setup();
    const session = await store.create({});
    const h = store.beginTurn(session.id, "t1");
    await h.partialCommit();
    expect(await store.getMessages(session.id)).toEqual([]);
    // session should be writable again immediately (openTurn cleared)
    const h2 = store.beginTurn(session.id, "t2");
    h2.append({ role: "user", content: "next" });
    await h2.commit();
    expect(await store.getMessages(session.id)).toEqual([{ role: "user", content: "next" }]);
  });

  test("partialCommit: user-only buffer persists user message", async () => {
    const { store } = setup();
    const session = await store.create({});
    const h = store.beginTurn(session.id, "t1");
    h.append({ role: "user", content: "hello" });
    await h.partialCommit();
    expect(await store.getMessages(session.id)).toEqual([{ role: "user", content: "hello" }]);
  });

  test("partialCommit: drops trailing assistant with unresolved toolCalls", async () => {
    const { store } = setup();
    const session = await store.create({});
    const h = store.beginTurn(session.id, "t1");
    h.append({ role: "user", content: "list files" });
    h.append({
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call_1", type: "function", function: { name: "glob", arguments: "{}" } }],
    });
    await h.partialCommit();
    expect(await store.getMessages(session.id)).toEqual([{ role: "user", content: "list files" }]);
  });

  test("partialCommit: keeps paired assistant+tool roundtrip", async () => {
    const { store } = setup();
    const session = await store.create({});
    const h = store.beginTurn(session.id, "t1");
    h.append({ role: "user", content: "list files" });
    h.append({
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call_1", type: "function", function: { name: "glob", arguments: "{}" } }],
    });
    h.append({ role: "tool", content: "a.txt\nb.txt", toolCallId: "call_1" });
    h.append({ role: "tool", content: "", toolCallId: "call_1" }); // second tool result is fine; algorithm only checks last msg
    await h.partialCommit();
    const msgs = await store.getMessages(session.id);
    expect(msgs).toHaveLength(4);
    expect(msgs[msgs.length - 1]?.role).toBe("tool");
  });

  test("partialCommit: drops trailing assistant after a completed roundtrip", async () => {
    const { store } = setup();
    const session = await store.create({});
    const h = store.beginTurn(session.id, "t1");
    h.append({ role: "user", content: "list files" });
    h.append({
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call_1", type: "function", function: { name: "glob", arguments: "{}" } }],
    });
    h.append({ role: "tool", content: "a.txt", toolCallId: "call_1" });
    h.append({
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call_2", type: "function", function: { name: "read", arguments: "{}" } }],
    });
    await h.partialCommit();
    const msgs = await store.getMessages(session.id);
    expect(msgs).toHaveLength(3);
    expect(msgs[2]?.role).toBe("tool");
  });

  test("partialCommit: no-op after commit", async () => {
    const { store } = setup();
    const session = await store.create({});
    const h = store.beginTurn(session.id, "t1");
    h.append({ role: "user", content: "x" });
    await h.commit();
    await h.partialCommit(); // must not throw, must not double-write
    expect(await store.getMessages(session.id)).toEqual([{ role: "user", content: "x" }]);
  });

  test("partialCommit: no-op after rollback", async () => {
    const { store } = setup();
    const session = await store.create({});
    const h = store.beginTurn(session.id, "t1");
    h.append({ role: "user", content: "x" });
    await h.rollback();
    await h.partialCommit(); // must not throw
    expect(await store.getMessages(session.id)).toEqual([]);
  });
```

- [ ] **Step 2: Run the new tests, expect RED**

```bash
cd plugins/llm-session-manager && bun test test/store.test.ts
```

Expected: 7 new tests fail with `partialCommit: not yet implemented` (or `Expected ... received ...` on the no-op-after-commit/rollback tests). All other tests still pass.

- [ ] **Step 3: Commit failing tests**

```bash
git add plugins/llm-session-manager/test/store.test.ts
git commit -m "session-manager: failing tests for partialCommit semantics"
```

---

### Task 3: Implement `partialCommit` — make Task 2 tests green

**Files:**
- Modify: `plugins/llm-session-manager/store.ts:216-242`

- [ ] **Step 1: Refactor — extract the snapshot-write block from `commit` into a helper**

Inside `beginTurn`, just before the `const handle: TurnHandle = { ... }` declaration, add:

```ts
    async function writeBufferedMessages(messagesToWrite: ChatMessage[]) {
      const next: Snapshot = {
        ...sess.snapshot,
        messages: [...sess.snapshot.messages, ...messagesToWrite],
        lastTurnAt: deps.now(),
      };
      const paths = sessionPaths(root, id);
      await sess.events.flush();
      await writeSnapshotAtomic(paths.snapshot, paths.snapshotTmp, next);
      sess.snapshot = next;
      sess.record = recordFromSnapshot(next);
      sess.openTurn = undefined;
      try {
        await index.appendUpdate({ id, lastTurnAt: next.lastTurnAt! });
      } catch (err) {
        deps.log(`sessions: index update failed for ${id}: ${String((err as any)?.message ?? err)}`);
      }
    }
```

- [ ] **Step 2: Replace the body of `commit` to use the helper**

```ts
      async commit() {
        if (closed) return;
        await writeBufferedMessages(bufferedMessages);
        closed = true;
        committed = true;
      },
```

- [ ] **Step 3: Replace the throwing `partialCommit` stub with the real implementation**

```ts
      async partialCommit() {
        if (closed) return;
        const trimmed = [...bufferedMessages];
        const last = trimmed[trimmed.length - 1];
        if (last && last.role === "assistant" && Array.isArray(last.toolCalls) && last.toolCalls.length > 0) {
          trimmed.pop();
        }
        if (trimmed.length === 0) {
          sess.openTurn = undefined;
          closed = true;
          return;
        }
        await writeBufferedMessages(trimmed);
        closed = true;
        committed = true;
      },
```

- [ ] **Step 4: Run unit tests, expect GREEN**

```bash
cd plugins/llm-session-manager && bun test test/store.test.ts
```

Expected: all tests pass (including all 7 new `partialCommit` tests and the existing `commit`/`rollback`/single-writer test).

- [ ] **Step 5: Run the full plugin test suite to catch regressions**

```bash
cd plugins/llm-session-manager && bun test
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add plugins/llm-session-manager/store.ts
git commit -m "session-manager: implement partialCommit on TurnHandle"
```

---

### Task 4: TDD — failing driver integration test for cancel-preserves-message

**Files:**
- Modify: `plugins/llm-driver/test/integration.test.ts`

- [ ] **Step 1: Strengthen the test fake's `partialCommit` to match real semantics**

In `plugins/llm-driver/test/integration.test.ts:17-26`, replace the stub from Task 1 with a faithful implementation so the integration test can observe real behavior:

```ts
    beginTurn(id: string, turnId: string) {
      const buffer: ChatMessage[] = [];
      open.set(id, buffer);
      return {
        turnId,
        append: (msg: ChatMessage) => buffer.push(msg),
        commit: async () => { messages.set(id, [...(messages.get(id) ?? []), ...buffer]); open.delete(id); },
        rollback: async () => { open.delete(id); },
        partialCommit: async () => {
          const trimmed = [...buffer];
          const last = trimmed[trimmed.length - 1];
          if (last && last.role === "assistant" && Array.isArray(last.toolCalls) && last.toolCalls.length > 0) {
            trimmed.pop();
          }
          if (trimmed.length > 0) {
            messages.set(id, [...(messages.get(id) ?? []), ...trimmed]);
          }
          open.delete(id);
        },
      };
    },
```

- [ ] **Step 2: Add a new `it` block at the end of the existing `describe` in `integration.test.ts`**

```ts
  it("cancel during in-flight LLM call preserves the user message in the snapshot", async () => {
    const handlers: Record<string, Function[]> = {};
    const events: { name: string; payload: any }[] = [];
    const ui = {
      i: 0,
      readInput: async function () { return this.i++ === 0 ? "amend my request later" : ""; },
      setBusy: () => {},
      setBusyTiming: () => {},
      writeOutput: () => {},
      writeNotice: () => {},
    };
    // LLM that never resolves on its own — we cancel it.
    const llm = {
      complete: async function* (_req: any, opts?: { signal?: AbortSignal }) {
        await new Promise<void>((resolve, reject) => {
          if (opts?.signal?.aborted) return reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          opts?.signal?.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        });
        yield { type: "done", response: { content: "", finishReason: "stop" } } as const;
      },
      async listModels() { return []; },
    };
    const sessions = makeSessions();
    const ctx: any = {
      log: () => {},
      config: { defaultSystemPrompt: "sp" },
      defineService: () => {},
      provideService: () => {},
      requireService: (name: string) => {
        if (name === "llm") return llm;
        if (name === "ui-channel") return ui;
        if (name === "sessions") return sessions;
        return undefined;
      },
      on: (event: string, fn: Function) => { (handlers[event] ??= []).push(fn); },
      emit: async (name: string, payload: any) => {
        events.push({ name, payload });
        for (const h of handlers[name] ?? []) await h(payload);
        return [];
      },
    };

    await plugin.setup?.(ctx);
    // Fire turn:cancel shortly after start to abort the pending LLM call.
    setTimeout(() => { ctx.emit("turn:cancel", {}); }, 10);
    await plugin.start?.(ctx);

    // Find the active session id from emitted events.
    const created = events.find((e) => e.name === "session:active-changed");
    const sessionId = created?.payload?.to;
    expect(sessionId).toBeTruthy();
    const snapshot = await sessions.getMessages(sessionId);
    expect(snapshot).toEqual([{ role: "user", content: "amend my request later" }]);

    const turnEnd = events.find((e) => e.name === "turn:end");
    expect(turnEnd?.payload?.reason).toBe("cancelled");
  });
```

(Adjust `plugin.setup` / `plugin.start` invocation to whatever shape the existing tests in this file use — copy the boilerplate from the existing `it` block at the top.)

- [ ] **Step 3: Run the test, expect RED**

```bash
cd plugins/llm-driver && bun test test/integration.test.ts
```

Expected: the new test fails because `index.ts` currently calls `handle.rollback()` on AbortError, so the snapshot is empty (`[]`) instead of `[{ role: "user", content: "amend my request later" }]`.

- [ ] **Step 4: Commit failing test**

```bash
git add plugins/llm-driver/test/integration.test.ts
git commit -m "driver: failing test for cancel-preserves-user-message"
```

---

### Task 5: Wire `partialCommit` into the AbortError branch — make Task 4 green

**Files:**
- Modify: `plugins/llm-driver/index.ts:261-275`
- Modify: `plugins/llm-driver/loop.ts:304-312`

- [ ] **Step 1: Update `plugins/llm-driver/index.ts` catch branch**

Find the block at lines `261-275`:

```ts
        } catch (err: any) {
          await handle.rollback();
          const isAbort = err?.name === "AbortError" || controller.signal.aborted;
          if (isAbort) {
            ui.writeNotice("↯ cancelled");
            await ctx.emit("turn:end", { turnId, sessionId, reason: "cancelled" });
          } else {
            await ctx.emit("turn:error", { turnId, sessionId, message: err?.message ?? String(err), cause: err });
            await ctx.emit("turn:end", { turnId, sessionId, reason: "error" });
          }
        } finally {
```

Replace with:

```ts
        } catch (err: any) {
          const isAbort = err?.name === "AbortError" || controller.signal.aborted;
          if (isAbort) {
            await handle.partialCommit();
            ui.writeNotice("↯ cancelled");
            await ctx.emit("turn:end", { turnId, sessionId, reason: "cancelled" });
          } else {
            await handle.rollback();
            await ctx.emit("turn:error", { turnId, sessionId, message: err?.message ?? String(err), cause: err });
            await ctx.emit("turn:end", { turnId, sessionId, reason: "error" });
          }
        } finally {
```

- [ ] **Step 2: Update `plugins/llm-driver/loop.ts:304-312` catch branch**

Read the current block first (lines 304-312 area) and apply the same branching: in owned-turn mode, call `turnHandle.partialCommit()` when `isAbort`, otherwise `turnHandle.rollback()`. The existing `reason` derivation (`isAbort ? "cancelled" : "error"`) stays the same. Concretely:

```ts
  } catch (err: any) {
    if (ownsTurn) {
      const isAbort = err?.name === "AbortError" || signal.aborted;
      if (isAbort) {
        await turnHandle.partialCommit();
      } else {
        await turnHandle.rollback();
      }
      const reason = isAbort ? "cancelled" : "error";
      // ... preserve any existing emit logic below for turn:error / turn:end
```

(Read lines 304-320 first; preserve any other logic in the catch besides the rollback call.)

- [ ] **Step 3: Run the driver test suite**

```bash
cd plugins/llm-driver && bun test
```

Expected: all tests pass, including the new Task 4 integration test. Pay attention to `loop.test.ts` — if any test asserted `rollback` was called on cancel, it now needs to assert `partialCommit`.

- [ ] **Step 4: If `loop.test.ts` regresses, update assertions**

Find and update any `expect(...rollback...).toHaveBeenCalled()` style assertions on cancel paths to `partialCommit` instead. Keep `rollback` assertions on non-abort error paths.

- [ ] **Step 5: Run both plugin test suites**

```bash
cd plugins/llm-session-manager && bun test
cd ../llm-driver && bun test
```

Expected: both green.

- [ ] **Step 6: Commit**

```bash
git add plugins/llm-driver/index.ts plugins/llm-driver/loop.ts plugins/llm-driver/test
git commit -m "driver: route cancel through partialCommit; rollback only on hard errors"
```

---

### Task 6: Documentation — CLAUDE.md and README updates

**Files:**
- Modify: `plugins/llm-driver/CLAUDE.md`
- Modify: `plugins/llm-session-manager/CLAUDE.md`
- Modify: `plugins/llm-driver/README.md:10`
- Modify: `plugins/llm-session-manager/README.md:17`

- [ ] **Step 1: Update `plugins/llm-driver/CLAUDE.md` invariant**

Find the invariant line:

> **Cancellation rolls back.** Message writes go through a `TurnHandle`. On AbortError, roll back the handle and emit `turn:end { reason: "cancelled" }`. Same for non-abort errors → `reason: "error"`.

Replace with:

> **Cancellation partially commits.** Message writes go through a `TurnHandle`. On AbortError, call `partialCommit()` — this preserves the user message and any completed assistant/tool roundtrips, dropping a trailing assistant message whose `toolCalls` have no matching tool results. Emit `turn:end { reason: "cancelled" }`. Non-abort errors still call `rollback()` (full discard) and emit `turn:end { reason: "error" }`.

- [ ] **Step 2: Update `plugins/llm-session-manager/CLAUDE.md`**

Add a new bullet to the existing invariants list:

> - `TurnHandle.partialCommit()` is the cancel-path persistence call. It drops a trailing `assistant` message with unresolved `toolCalls` and writes whatever remains; an empty post-trim buffer behaves like `rollback()`. `events.jsonl` is still append-only and is *not* trimmed — the debug trail may include the dropped trailing assistant; `snapshot.json` will not.

- [ ] **Step 3: Update `plugins/llm-driver/README.md:10`**

Find:

> - Cancellation: subscribes to `turn:cancel` and aborts the in-flight controller. On cancel, the current turn handle rolls back.

Replace with:

> - Cancellation: subscribes to `turn:cancel` and aborts the in-flight controller. On cancel, the current turn handle is *partially committed* — the user message and any completed tool roundtrips are persisted to the snapshot; a trailing assistant message with unresolved `toolCalls` is dropped. Non-abort errors still roll back fully.

- [ ] **Step 4: Update `plugins/llm-session-manager/README.md:17`**

Find:

> All message writes happen through `TurnHandle`. A committed turn atomically rewrites `snapshot.json`; a rolled-back turn discards buffered messages while leaving trace events intact for auditability.

Replace with:

> All message writes happen through `TurnHandle`. A committed turn atomically rewrites `snapshot.json`. A rolled-back turn discards buffered messages while leaving trace events intact for auditability. A partially-committed turn (cancellation path) drops a trailing assistant message with unresolved tool_calls and persists the rest; `events.jsonl` is not trimmed in either case.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-driver/CLAUDE.md plugins/llm-session-manager/CLAUDE.md plugins/llm-driver/README.md plugins/llm-session-manager/README.md
git commit -m "docs: cancel-path now partial-commits, not rolls back"
```

---

### Task 7: Local deploy — rebuild dist bundles in kaizen install dirs

**Files:**
- No source files modified; this task copies + builds.

- [ ] **Step 1: Locate the actual install paths**

```bash
ls ~/.kaizen/marketplaces/official/plugins/ | grep -E "llm-(driver|session-manager)"
```

Note the exact directory names (versioned, e.g. `llm-driver@0.1.0`). Substitute below.

- [ ] **Step 2: Sync `llm-session-manager` and build**

```bash
cp -R plugins/llm-session-manager/. ~/.kaizen/marketplaces/official/plugins/llm-session-manager@<VERSION>/
(cd ~/.kaizen/marketplaces/official/plugins/llm-session-manager@<VERSION> \
  && bun build --target=bun --outfile=dist/index.js index.ts)
```

Expected: bundle written, no errors.

- [ ] **Step 3: Sync `llm-driver` and build**

```bash
cp -R plugins/llm-driver/. ~/.kaizen/marketplaces/official/plugins/llm-driver@<VERSION>/
(cd ~/.kaizen/marketplaces/official/plugins/llm-driver@<VERSION> \
  && bun build --target=bun --outfile=dist/index.js index.ts)
```

Expected: bundle written, no errors.

- [ ] **Step 4: Smoke test**

Launch the harness, send a prompt, Ctrl+C mid-response, then send a follow-up like "what file were you about to read?" — the assistant should reference the original prompt rather than treat the follow-up as fresh context.

- [ ] **Step 5: No commit needed for the deploy itself** (dist dirs are gitignored per `292fc9b chore: gitignore plugin dist/ bundle output`).

---

## Self-review notes

- **Spec coverage:** every section of the design doc maps to a task —
  - Algorithm → Task 3
  - `TurnHandle.partialCommit` API → Tasks 1 & 3
  - Driver index.ts wiring → Task 5
  - loop.ts wiring → Task 5
  - CLAUDE.md updates (both plugins) → Task 6
  - README updates → Task 6
  - Unit tests → Task 2
  - Driver integration test → Tasks 4 & 5
  - Deploy → Task 7
- **Buffer-shape rule** (drop trailing assistant with `toolCalls?.length > 0`) is implemented identically in Task 3 (real code) and Task 4 (test fake). Property names match the `ChatMessage` interface (`role`, `toolCalls`, `toolCallId`).
- **No placeholders** — every code block is concrete. The only `<VERSION>` substitution is in Task 7 (deploy), where the exact directory name has to be discovered at runtime.
