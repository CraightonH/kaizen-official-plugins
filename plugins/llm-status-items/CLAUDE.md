# Working in `llm-status-items`

Notes for agents editing this plugin. See `README.md` for the user-facing contract.

## Module map

```
index.ts      Plugin lifecycle. The only file that touches `ctx`. Owns:
              - event subscription wiring (the SUBSCRIBED list)
              - lazy listModels() probe + per-model context-cache
              - emitDiff() — the only place status:item-update / status:item-clear are emitted for the non-cost items
              - emitCost() — the only place the cost-estimate item is emitted
              - lastEmitted dedup map
state.ts      applyEvent(prev, name, payload) → StatusState. Pure reducer.
              Owns the StatusState shape, the `cleared` one-shot flag, tok/s
              math, and per-turn delta tracking. No I/O.
cost.ts      loadRateTable() / tokensToCents() / formatDollars(). Pure.
              CostDeps abstraction lets tests inject an in-memory rate file.
context.ts   formatContextItem(used, ceiling) → "13.2k/32k [██░░] 41%". Pure.
              Caller is responsible for not invoking it when ceiling is unknown.
```

Boundaries:
- Only `index.ts` imports `kaizen/types` or touches `ctx`. The other three modules are pure and independently testable.
- `state.ts` is the single source of truth for derived status (`turn-state`, `tokensPerSec`, etc.). Don't re-derive these in `index.ts` — extend the reducer instead.

## Invariants

- **Diff-or-skip.** Every status emission goes through the `lastEmitted` map. Re-emitting an unchanged value is a bug — the TUI re-renders unnecessarily and tests assert single emissions.
- **`cleared` is one-shot.** `applyEvent` resets it at the top of every event. `index.ts` reads it on the same tick as `conversation:cleared` and never sees it again.
- **Cost is opt-in.** No rate file → `hasAnyRate === false` → `emitCost` is a no-op. Production runs against local providers must emit zero `cost-estimate` events.
- **`turn:end` owns `turnInFlight = false`.** `llm:done` updates token totals only. Don't conflate them — providers can emit multiple `llm:done`s per turn (tool-call rounds), but `turn:end` fires once.
- **Context ceiling is resolved at most once per model id.** `contextCache` and `modelsListed` gate `listModels()`. Providers without `listModels` must not be retried.
- **`lastPromptTokens` ≠ cumulative `promptTokens`.** The `_ctx` item is denominated against the most recent call's prompt size (what the model actually saw), not session totals. Don't "fix" this.
- **Empty status is worse than zeros.** `initialized` flips on `session:start` so zero-valued counters are emitted before the first turn runs. Don't suppress them.

## Adding a new status item

1. Extend `StatusState` in `state.ts` with the new field; default it in `initialState()`.
2. Update `applyEvent` to maintain the field. Add tests in `test/state.test.ts`.
3. In `index.ts`, add a `lastEmitted.<slot>` entry and a diff-emit block in `emitDiff()`. If `conversation:cleared` should reset it, handle that in the `state.cleared` branch.
4. Use the existing key namespace conventions: short user-facing keys (`in`, `out`, `tok/s`); leading-underscore for non-textual or wide items (`_ctx`).

## Cost table extensions

`cost-table.json` is intentionally flat (`{ rates: { <model-id>: { promptCentsPerMTok, completionCentsPerMTok } } }`). If you add fields, treat them as optional and keep the existing shape backward-compatible — users hand-edit this file.

`tokensToCents` returning `null` is the "model not priced" signal. Preserve that — `emitCost` clears any prior estimate when it's seen, and downgrading to zero would be wrong (a partially-priced session is misleading).

## Testing

```bash
cd plugins/llm-status-items && bun test
```

Tests use `bun:test` only. `test/index.test.ts` ships a `makeCtx()` helper that fakes `ctx.on` / `ctx.emit` / `ctx.useService` and injects an in-memory rate table via the `_testCostDeps` private hook on ctx (production code never reads it). Use it for lifecycle tests; use `state.test.ts` / `cost.test.ts` patterns for pure-module tests.

## Local deploy

The Kaizen runtime prefers the bundled `dist/index.js` over source. After editing, the plugin must be re-bundled into the install dir:

```bash
cp -R plugins/llm-status-items/. ~/.kaizen/marketplaces/official/plugins/llm-status-items@0.1.0/
(cd ~/.kaizen/marketplaces/official/plugins/llm-status-items@0.1.0 \
  && bun build --target=bun --outfile=dist/index.js index.ts)
```

If you also need the harness manifest to pick up changes, sync the local marketplace repo (`~/.kaizen/marketplaces/official/repo/`) — it tracks upstream `main` and `kaizen marketplace update` will overwrite local edits.
