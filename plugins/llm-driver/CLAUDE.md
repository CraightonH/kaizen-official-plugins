# Working in `llm-driver`

Notes for agents editing this plugin. See `README.md` for the user-facing contract.

## Module map

```
index.ts            Plugin lifecycle. Defines plugin-scoped state, registers subscribers in setup()
                    (kaizen forbids ctx.on after init), runs the interactive REPL in start().
                    The only file that touches `ctx` directly.
loop.ts             runConversation(input, deps) — pure (deps-injected). Owns session-backed
                    message reads, the LLM call, A-tier single-call path, multi-step
                    strategy/tool loop, and the per-deps WeakMap assemblyCache for
                    prompt:system. Emits all `llm:*` events and emits `turn:*` lifecycle
                    events only in owned-turn mode.
state.ts            CurrentTurn type and aggregateUsage(). Pure.
cancel.ts           wireCancel(ctx, getCurrent) → unsubscribe. Subscribes to turn:cancel and
                    aborts the current controller (turn-id-targeted or untargeted).
ids.ts              newTurnId() (uuid-prefixed), makeIdGen(seq) for deterministic test ids.
busy-messages.ts    Random "thinking…" pool for ui.setBusy().
done-messages.ts    Random verb pool for the post-turn duration notice.
public.d.ts         DriverService / RunConversationInput / RunConversationOutput, plus
                    ToolDispatchStrategy / ToolDispatchRegistry for the dispatch extension
                    point. Re-exports the chat/llm types from llm-events/public so
                    consumers have one import.
```

Boundaries:
- `index.ts` is the only file that imports from `kaizen/types` or touches `ctx`. Everything else takes its dependencies via parameters.
- `loop.ts` knows nothing about the UI. It emits events; `index.ts` wires those events to the channel.
- Tests live alongside in `test/` and run independently (`bun test`).

## Invariants

- **Plugin-scoped state, not ctx-scoped.** `setup()` and `start()` receive different `ctx` instances. Mutable state (`currentTurn`, `activeSessionId`, `systemPrompt`, `inputHandled`, `exitRequested`, `moduleUi`, `buildDeps`, `depsCache`) lives at module scope. Reset on every `setup()`.
- **Subscribers register in `setup()` only.** Kaizen forbids `ctx.on` after init. If a subscriber needs the UI channel (resolved in `start()`), it reads `moduleUi` lazily.
- **Turn ownership.** `runConversation` emits `turn:start`/`turn:end` only in owned-turn mode (`userMessage`). The interactive loop in `index.ts` owns the outer turn and passes `externalTurnId` plus a `turnHandle` so loop.ts does not double-emit or commit.
- **Cancellation partially commits.** Message writes go through a `TurnHandle`. On AbortError, call `partialCommit()` — this preserves the user message and any completed assistant/tool roundtrips, dropping a trailing assistant message whose `toolCalls` have no matching tool results. Emit `turn:end { reason: "cancelled" }`. Non-abort errors still call `rollback()` (full discard) and emit `turn:end { reason: "error" }`.
- **Deps bag is memoized.** `buildDeps()` returns the same object every call. The `assemblyCache` WeakMap is keyed on the deps bag — a fresh object every call would defeat the cache.
- **Generation-keyed prompt cache.** `resolveSystemPrompt` checks `promptSystem.generation()` per turn against the cached entry. Do not add a `prompt:rebuilt` subscription — generation is the source of truth and re-checking is cheap.
- **`llm:request` payloads are frozen.** The request object emitted on `llm:request` is a deep-frozen `structuredClone` of the live request. Subscribers can read but not mutate.
- **`llm:before-call` is mutable + cancellable.** Subscribers may mutate the request. Setting `request.cancelled = true` ends the turn cleanly with `reason: "complete"` and the most recent message as `finalMessage`.
- **A-tier degradation.** Missing `tools:registry` or `tool-dispatch:strategy` → single LLM call, no loop. Don't add code paths that assume both are present without an explicit guard.

## Adding a new lifecycle event

1. Declare it in the `llm-events` VOCAB (this plugin does not define events).
2. Emit from `loop.ts` (per-call events) or `index.ts` (harness/session loop-level events). Match the existing naming (`harness:*`, `session:*`, `turn:*`, `llm:*`, `conversation:*`).
3. If it is observable by consumers, add it to the README's "Events emitted" list.

## Adding a new short-circuit hook

Pattern is the `input:handled` flag:

1. Module-scope `let xxxFlag = false`.
2. Reset in `setup()` and on every relevant tick in `start()`.
3. Subscribe in `setup()` (`ctx.on("event", () => { xxxFlag = true; })`).
4. Consume the flag at the appropriate point in the `start()` loop.

Do not stash flags on the ctx — the start-ctx is a different object than the setup-ctx.

## Editing the strategy/tool loop

The first LLM call happens inline in `runConversation` (so the A-tier path can return immediately). The multi-step loop reuses `response` from that first call as the seed; do not call `prepareRequest` twice for the first iteration.

`handleResponse` returning `[]` means "the strategy is done; the latest assistant message is the final answer". An empty array does not mean "error" — do not throw.

## Testing

```bash
cd plugins/llm-driver && bun test
```

Tests use `bun:test` only. `makeIdGen(seq)` from `ids.ts` is the standard way to make turn ids deterministic in tests. `integration.test.ts` and `system-prompt-integration.test.ts` exercise the full loop with fake services; prefer extending those over building new harnesses.

## Local deploy

The Kaizen runtime prefers the bundled `dist/index.js` over source. After editing, the plugin must be re-bundled into the install dir:

```bash
cp -R plugins/llm-driver/. ~/.kaizen/marketplaces/official/plugins/llm-driver@0.2.1/
(cd ~/.kaizen/marketplaces/official/plugins/llm-driver@0.2.1 \
  && bun build --target=bun --outfile=dist/index.js index.ts)
```

If you also need the harness manifest to pick up changes, sync the local marketplace repo (`~/.kaizen/marketplaces/official/repo/`) — it tracks upstream `main` and `kaizen marketplace update` will overwrite local edits.
