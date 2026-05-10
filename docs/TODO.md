1. Turn cancellation discards the user's message:

   Yes — cancellation throws away the whole turn including your user message. Here's the trace:

   **`plugins/llm-driver/index.ts:222-275`:** Each turn opens a `TurnHandle` via `sessions.beginTurn(...)`. Your user message is `handle.append(...)`-ed *into a buffer*. The buffer only gets persisted to the session snapshot when `handle.commit()` runs at the happy-path tail.

   **`plugins/llm-session-manager/store.ts:237-242` — `rollback()`:**
   ```ts
   async rollback() {
     if (committed) return;
     if (closed) return;
     sess.openTurn = undefined;
     closed = true;
   },
   ```
   It discards `bufferedMessages` entirely. No partial commit, no record.

   **`plugins/llm-driver/index.ts:262`** in the catch block: `await handle.rollback();` runs on *any* throw, including the AbortError from `controller.abort()` (which is what `turn:cancel` triggers via `cancel.ts:13`).

   So when you cancelled:
   1. Your "test insert by adding 20 lines..." message → buffered, then rolled back. Gone from the snapshot the LLM sees.
   2. The model's partial thoughts + the `glob` call/result → also in that buffer, also gone.
   3. The `events.jsonl` trace still has them (per the session-manager invariant), but **the LLM reads from `snapshot.json`, not events**.

   Next turn, the model's context contains: previous turns + "Sorry I meant in test.txt". With no antecedent for "it", it picks a reasonable interpretation ("show me what you can do with test.txt") rather than the nudge you intended.

   This is by design per `llm-driver/CLAUDE.md`: *"Cancellation rolls back."* It makes sense if you cancel because the model is off-rails and you want a clean slate, but it's wrong for the much more common case where you want to amend mid-flight.

   **Three fixes, in order of how much I'd recommend each:**

   1. **Partial commit: keep the user message (and completed tool calls), drop the in-flight assistant turn.** Add `handle.partialCommit()` (or pass `{ keepUser: true }` to rollback) that flushes only messages with role `user` and completed tool roundtrips, dropping any in-progress assistant message. Best default — preserves intent without polluting context with half-thoughts.
   2. **Commit everything buffered, with a synthetic `[cancelled by user]` marker on the truncated assistant message.** Maximum context fidelity (the model can see "you started a glob, I interrupted, here's what I really wanted"). Risk: noisier context, occasional weirdness if the model fixates on the cancelled work.
   3. **Leave behavior, fix the UX.** When cancelling, show `"↯ cancelled — message discarded"` so the user knows their prompt was dropped and can re-send it intact. Smallest change, but doesn't actually solve the "nudge me" workflow.

   I'd go with #1.
