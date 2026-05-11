# Cancel preserves user message and completed tool work

**Status:** approved, ready for implementation plan
**Date:** 2026-05-10
**Plugins affected:** `llm-session-manager`, `llm-driver`

## Problem

When a user cancels a turn (Ctrl+C → `turn:cancel` → `AbortController.abort()` → AbortError), the entire turn is rolled back. The user's original message is discarded along with the assistant's partial output and any completed tool work. The next message has no antecedent for follow-up phrasing like "I meant in test.txt".

Trace:
- `plugins/llm-driver/index.ts:222-275` — each turn buffers messages via `TurnHandle.append()` and only persists on `handle.commit()` at the happy-path tail.
- `plugins/llm-session-manager/store.ts:237-242` — `rollback()` clears `bufferedMessages` and `sess.openTurn` with no partial commit.
- `plugins/llm-driver/index.ts:262` — the catch block calls `handle.rollback()` on *any* throw, including AbortError.

`events.jsonl` still records the dropped messages (append-only per session-manager invariants), but the LLM reads from `snapshot.json` on the next turn.

## Goal

On AbortError, persist:
- The user's original message.
- Any completed assistant/tool roundtrips (paired assistant-with-toolCalls + matching tool results).

Drop:
- A trailing assistant message whose `toolCalls` never received tool results.

Non-abort errors continue to roll back fully — a thrown error mid-turn means buffer state is suspect.

## Buffer shapes at cancel time

`loop.ts` appends messages in atomic units only after `makeRequest()` resolves (lines 251, 283, 302). Streaming partials never hit the buffer. So at cancel time the buffer is always one of:

- `[user]` — aborted during first LLM call
- `[user, assistant(toolCalls)]` — aborted mid-tool-execution
- `[user, assistant(toolCalls), tool, tool, ...]` — aborted between turns of the loop
- `[user, ..., assistant(toolCalls), tools..., assistant(toolCalls)]` — same, repeating

The only problematic shape is one ending in an `assistant` message with `toolCalls` and no matching `tool` results after it. Most LLM providers reject unmatched tool_calls in the next request.

## Algorithm

`partialCommit()`:

1. If the last buffered message is `role: "assistant"` with non-empty `toolCalls`, pop it.
2. If the buffer is now empty → behave like `rollback()` (clear `openTurn`, set `closed`, no snapshot write).
3. Otherwise → write snapshot via the same `writeSnapshotAtomic` path `commit()` uses; update `sess.snapshot`, `sess.record`, index.

Edge: if the assistant emitted both text *and* toolCalls and we cancel before tools run, we drop the text too. Acceptable — that text is reasoning toward a tool action that never happened, not a standalone reply.

## Changes

### 1. `plugins/llm-session-manager/store.ts` — add `partialCommit()` to `TurnHandle`

- Same closure as `commit`/`rollback`; honors `committed`/`closed` guards.
- Implements the algorithm above.
- Reuses the snapshot-write path from `commit()` (no duplication).
- Update `TurnHandle` type in `public.d.ts`.

### 2. `plugins/llm-driver/index.ts` — branch the catch on AbortError

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
}
```

### 3. `plugins/llm-driver/loop.ts:306` — mirror the same branching in the inner catch

For owned-turn mode (`userMessage` input path), use `partialCommit()` on AbortError and `rollback()` on other errors.

### 4. CLAUDE.md updates

- `plugins/llm-driver/CLAUDE.md`: replace the "Cancellation rolls back" invariant with:
  > **Cancellation partially commits.** AbortError → `partialCommit()` (preserves user message and completed tool roundtrips, drops trailing assistant with unresolved tool_calls). Non-abort errors still roll back fully.
- `plugins/llm-session-manager/CLAUDE.md`: document `partialCommit()` alongside the existing snapshot/events invariants. Note the divergence: `events.jsonl` still records the dropped trailing message (append-only invariant unchanged); `snapshot.json` does not.

### 5. README updates in both plugins where the cancel/rollback contract is mentioned.

## Tests

### `plugins/llm-session-manager/test/store.test.ts`

- `partialCommit()` with empty buffer → behaves as rollback, no snapshot write, `openTurn` cleared.
- Buffer `[user]` → persists `[user]`.
- Buffer `[user, assistant(toolCalls)]` → persists `[user]` (drops trailing).
- Buffer `[user, assistant(toolCalls), tool, tool]` → persists all four.
- Buffer `[user, assistant(toolCalls), tool, assistant(toolCalls)]` → persists first three (drops trailing).
- Calling `partialCommit()` after `commit()` → no-op (existing `committed` guard).
- Calling `partialCommit()` after `rollback()` → no-op (existing `closed` guard).

### `plugins/llm-driver/test/integration.test.ts`

- Fire `turn:cancel` after a tool result is buffered but before the next LLM call. Assert the next turn's `getMessages` includes the user message and the tool roundtrip; assert no dangling assistant.

## Out of scope

- **No new events.** `turn:end { reason: "cancelled" }` already fires; subscribers can inspect the snapshot.
- **No UX change** to the `"↯ cancelled"` notice. The snapshot state speaks for itself; revisit if users get confused.
- **No full-discard escape hatch.** The "wrong path, throw it away" cancel case is rarer than the "amend mid-flight" case. If usage data shows otherwise, a double-cancel binding is the smallest follow-up.

## Risk / known divergence

`events.jsonl` records the dropped trailing assistant (append-only, not rolled back per `llm-session-manager/CLAUDE.md`). That's existing behavior and intentional — the debug trail is allowed to diverge from the snapshot. Worth documenting but not changing.

## Deploy

Per `plugins/llm-driver/CLAUDE.md` and `plugins/llm-session-manager/CLAUDE.md`, both plugins need source-sync + `bun build` into their install dirs:

```bash
cp -R plugins/llm-session-manager/. ~/.kaizen/marketplaces/official/plugins/llm-session-manager@0.1.0/
(cd ~/.kaizen/marketplaces/official/plugins/llm-session-manager@0.1.0 \
  && bun build --target=bun --outfile=dist/index.js index.ts)
cp -R plugins/llm-driver/. ~/.kaizen/marketplaces/official/plugins/llm-driver@0.1.0/
(cd ~/.kaizen/marketplaces/official/plugins/llm-driver@0.1.0 \
  && bun build --target=bun --outfile=dist/index.js index.ts)
```
