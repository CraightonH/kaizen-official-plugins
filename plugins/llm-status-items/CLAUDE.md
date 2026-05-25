# Working in `llm-status-items`

Notes for agents editing this plugin. See `README.md` for the user-facing contract.

## Module map

```
index.ts      Plugin lifecycle. The only file that touches `ctx`. Owns:
              - config:store register + read (DEFAULT_CONFIG fallback)
              - event subscription wiring (the SUBSCRIBED list)
              - lazy listModels() probe + per-model context-cache
              - emitDiff() — the only place status:item-update / status:item-clear are emitted for the non-cost items
              - emitCost() — the only place the cost-estimate item is emitted
              - soft `/status:show` + `status:show` tool registration and teardown (gated by config.slashCommandEnabled / config.toolEnabled)
              - lastEmitted dedup map
config.ts     DEFAULT_CONFIG (frozen) + CONFIG_SCHEMA for config:store.
state.ts      applyEvent(prev, name, payload) → StatusState. Pure reducer.
              Owns the StatusState shape, the `cleared` one-shot flag, tok/s
              math, and per-turn delta tracking. No I/O.
cost.ts       tokensToCents() / formatDollars(cents, decimals). Pure.
              No FS, no Rate-file reader — rates come from config:store.
context.ts    formatContextItem(used, ceiling, { width, fillGlyph, emptyGlyph })
              → "13.2k/32k [██░░] 41%". Pure. Caller is responsible for not
              invoking it when ceiling is unknown.
public.d.ts   LlmStatusItemsConfig + CostRateEntry. Plugin-private.
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
- **Empty status is worse than zeros.** `initialized` flips on `harness:start` so zero-valued counters are emitted before the first turn runs. Don't suppress them.
- **Slash/tool adapters are soft and idempotent.** `slash:registry` and `tools:registry` are not manifest dependencies. They are probed at `harness:start`, registered at most once, and unregistered from `stop()`. Each adapter is additionally gated by `config.slashCommandEnabled` / `config.toolEnabled`.
- **Config is setup-time only.** All knobs (cost rates, bar dimensions, decimal places, thresholds, adapter toggles) are read once during `setup()`. No `watch()` — changing presentation knobs at runtime requires a restart.

## Adding a new status item

1. Extend `StatusState` in `state.ts` with the new field; default it in `initialState()`.
2. Update `applyEvent` to maintain the field. Add tests in `test/state.test.ts`.
3. In `index.ts`, add a `lastEmitted.<slot>` entry and a diff-emit block in `emitDiff()`. If `conversation:cleared` should reset it, handle that in the `state.cleared` branch.
4. Use the existing key namespace conventions: short user-facing keys (`in`, `out`, `tok/s`); leading-underscore for non-textual or wide items (`_ctx`).

## Cost rates

Rates live on `config.costRates` (Record<modelId, CostRateEntry>), validated by
`config:store` against `CONFIG_SCHEMA` in `config.ts`. Empty default — fully
local sessions never see a `cost-estimate` event. The legacy
`~/.kaizen/plugins/llm-status-items/cost-table.json` reader is gone; users
copy rates into `~/.kaizen/harnesses/<key>/config.json` by hand.

`tokensToCents` returning `null` is the "model not priced" signal. Preserve
that — `emitCost` clears any prior estimate when it's seen, and downgrading
to zero would be wrong (a partially-priced session is misleading).

## Testing

```bash
cd plugins/llm-status-items && bun test
```

Tests use `bun:test` only. `test/index.test.ts` ships a `makeCtx()` helper that fakes `ctx.on` / `ctx.emit` / `ctx.useService` and injects an in-memory `config:store` shim — pass `{ rateTable }` (writes through to `costRates`) or `{ configOverrides }` to override defaults. Use it for lifecycle tests; use `state.test.ts` / `cost.test.ts` patterns for pure-module tests.

## Local deploy

Build from the source directory (where workspace deps resolve), then sync into the install dir:

```bash
PLUGIN=llm-status-items
VERSION=$(jq -r .version plugins/$PLUGIN/package.json)
INSTALL_DIR=~/.kaizen/marketplaces/official/plugins/${PLUGIN}@${VERSION}
(cd plugins/$PLUGIN && bun build --target=bun --outfile=dist/index.js index.ts)
mkdir -p "$INSTALL_DIR/dist"
cp plugins/$PLUGIN/dist/index.js "$INSTALL_DIR/dist/index.js"
rsync -a --exclude='node_modules' --exclude='dist' plugins/$PLUGIN/ "$INSTALL_DIR/"
```

If you also need the harness manifest to pick up changes, sync the local marketplace repo (`~/.kaizen/marketplaces/official/repo/`) — it tracks upstream `main` and `kaizen marketplace update` will overwrite local edits.
