# Migration plan: llm-status-items

> **Scope note.** Most of `llm-status-items` is *runtime data* — model
> ids, token counters, throughput, session ids — pulled off the event bus
> and rendered as status-bar items. None of that is config. The
> configurable surface is small: a cost rate-table that today lives in a
> separate per-plugin JSON file, plus a handful of presentation knobs
> (context-bar width/glyphs, cost-format precision, tok/s decimal
> threshold) and the adapter feature flags for `/status:show` +
> `status:show`.

## Current state

Config-ish read sites:

- `plugins/llm-status-items/cost.ts:23` — `RATE_FILE_REL = ".kaizen/plugins/llm-status-items/cost-table.json"`. Hardcoded relative path under `homedir()`. Per-plugin JSON config file — exactly the kind of legacy reader INTEGRATION.md says to delete during migration.
- `plugins/llm-status-items/cost.ts:33-72` — `loadRateTable()` reads + validates the rate file. Its output is the user-tunable `Record<modelId, { promptCentsPerMTok, completionCentsPerMTok }>` table. Today: absent file → `{}` (cost feature silently disabled); malformed file or invalid entry → throw at setup.
- `plugins/llm-status-items/cost.ts:84-88` — `formatDollars()` hardcodes `.toFixed(4)` (4 decimal places).
- `plugins/llm-status-items/context.ts:2` — `const BAR_WIDTH = 10`. Context-bar cell count.
- `plugins/llm-status-items/context.ts:4-5` — `const FILL = "█"; const EMPTY = "░"`. Bar glyphs.
- `plugins/llm-status-items/index.ts:154-158` — tok/s formatting branch: `>= 10` renders `.toFixed(0)`, else `.toFixed(1)`. The threshold and decimal counts are hardcoded.
- `plugins/llm-status-items/index.ts:244-255` — `/status:show` slash command and `status:show` tool registrations are guarded only by whether `slash:registry` / `tools:registry` are present at `harness:start`. No explicit user opt-out today.

Config plumbing pre-existing in this plugin: none. No `process.env.*` reads. No constructor args wired from non-defaults. The cost-deps "test seam" (`_testCostDeps` on ctx, `plugins/llm-status-items/index.ts:41`) is not user-facing — it stays.

`README.md`'s "Configuration" section documents the legacy `~/.kaizen/plugins/llm-status-items/cost-table.json` path. The whole section is rewritten by this migration.

`plugin.json` / `package.json` declares `services.consumes: ["events:vocabulary", "llm:complete"]` — `config:store` needs to be added.

## Proposed `LlmStatusItemsConfig`

```ts
// plugins/llm-status-items/public.d.ts (plugin-private)

export interface CostRateEntry {
  promptCentsPerMTok: number;
  completionCentsPerMTok: number;
}

export interface LlmStatusItemsConfig {
  /**
   * Per-model cost rates. Replaces the legacy
   * ~/.kaizen/plugins/llm-status-items/cost-table.json file. Empty object
   * (the default) disables the cost-estimate status item entirely —
   * matching the "no rate file" behavior today.
   */
  costRates: Record<string, CostRateEntry>;

  /**
   * Number of decimal places used to render the running cost estimate.
   * `4` keeps the existing `$0.0123` format.
   */
  costDecimalPlaces: number;

  /**
   * Width in cells of the context-window fill bar (the `[████░░░░░░]`
   * segment). 10 = current behavior.
   */
  contextBarWidth: number;

  /** Glyph used for the filled portion of the context bar. */
  contextBarFillGlyph: string;

  /** Glyph used for the empty portion of the context bar. */
  contextBarEmptyGlyph: string;

  /**
   * Tokens-per-second threshold at or above which tok/s is rendered with
   * zero decimals; below it, one decimal. `10` = current behavior.
   */
  tokensPerSecIntegerThreshold: number;

  /**
   * When true (default), register `/status:show` against `slash:registry`
   * if that service is present at `harness:start`.
   */
  slashCommandEnabled: boolean;

  /**
   * When true (default), register the `status:show` tool against
   * `tools:registry` if that service is present at `harness:start`.
   */
  toolEnabled: boolean;
}
```

`CostRateEntry` is plugin-private — no other plugin consumes it. It does
not need to move to `llm-contracts`.

## Defaults and schema

| Field | Default | FieldSchema | Notes |
|-------|---------|-------------|-------|
| `costRates` | `{}` | `{ type: "object", properties: {}, additionalProperties: { type: "object", properties: { promptCentsPerMTok: { type: "number", min: 0 }, completionCentsPerMTok: { type: "number", min: 0 } }, additionalProperties: false } }` | Empty default reproduces "no rate file → cost item disabled" behavior. `additionalProperties` carries the per-model entry schema; the user adds model ids as keys. |
| `costDecimalPlaces` | `4` | `{ type: "number", min: 0, max: 8, integer: true }` | Bounded to keep `toFixed` sane. |
| `contextBarWidth` | `10` | `{ type: "number", min: 1, max: 40, integer: true }` | Status bar is one row — capping at 40 prevents pathological values. |
| `contextBarFillGlyph` | `"█"` | `{ type: "string", min: 1, max: 4 }` | Single grapheme, but tolerate up to 4 UTF-16 code units (combining sequences). |
| `contextBarEmptyGlyph` | `"░"` | `{ type: "string", min: 1, max: 4 }` | Same shape as fill glyph. |
| `tokensPerSecIntegerThreshold` | `10` | `{ type: "number", min: 0 }` | Float allowed — user could set `1.0` to always-integer. |
| `slashCommandEnabled` | `true` | `{ type: "boolean" }` | Preserves the auto-register behavior; `false` skips the soft adapter even if `slash:registry` is present. |
| `toolEnabled` | `true` | `{ type: "boolean" }` | Same shape for the `tools:registry` adapter. |

Validation policy: schema is strict on shape/range but does **not**
enforce that `costRates` is non-empty — an empty table is a legitimate
configuration ("cost feature off"). Per INTEGRATION.md, invalid values
on boot log + fall back to defaults; on `set()` they reject.

## Code changes

Files to add:

- `plugins/llm-status-items/public.d.ts` — declare `LlmStatusItemsConfig` and `CostRateEntry`. Currently the plugin has no `public.d.ts`; this is a brand-new file.
- `plugins/llm-status-items/config.ts` — exports `DEFAULT_CONFIG` (frozen) and `CONFIG_SCHEMA: Record<keyof LlmStatusItemsConfig, FieldSchema>`. Mirrors `plugins/llm-axioms/config.ts`.

Files to edit:

- `plugins/llm-status-items/cost.ts`:
  - Delete `loadRateTable()`, `RATE_FILE_REL`, `realCostDeps()`, the `CostDeps` interface, the `node:fs/promises` / `node:os` / `node:path` imports, and the `isPlainObject` / `asNonNegativeNumber` helpers. The whole file/validation pipeline is gone — config:store does the validation now.
  - Keep `RateEntry` (or replace by re-exporting `CostRateEntry` from `public.d.ts`), `RateTable`, `tokensToCents`, `formatDollars`.
  - Change `formatDollars(cents)` → `formatDollars(cents, decimalPlaces)`. Replace the hardcoded `.toFixed(4)` with `.toFixed(decimalPlaces)`.
- `plugins/llm-status-items/context.ts`:
  - Drop the module-level `BAR_WIDTH`, `FILL`, `EMPTY` constants.
  - Change the `formatContextItem(used, ceiling)` signature to `formatContextItem(used, ceiling, opts: { width: number; fillGlyph: string; emptyGlyph: string })`. Repeat-glyph math stays as-is.
- `plugins/llm-status-items/index.ts`:
  - Add the standard `config:store` registration block at the top of `setup()` — mirror the template in INTEGRATION.md (try/catch, `useService` topo-hint optional, fall back to `{ ...DEFAULT_CONFIG }` on missing service or failure). Plugin name: `"llm-status-items"`.
  - Replace `const costDeps: CostDeps = (ctx as any)._testCostDeps ?? realCostDeps();` and the subsequent `await loadRateTable(costDeps)` with `const rates: RateTable = config.costRates;`. Delete the `_testCostDeps` indirection — `bun test`'s `makeCtx()` should drive the rate table through `register()` defaults instead of the private hook.
  - `hasAnyRate` becomes `Object.keys(config.costRates).length > 0`.
  - Pass `config.costDecimalPlaces` into `formatDollars()`.
  - Replace the hardcoded `>= 10` threshold and decimal counts with `config.tokensPerSecIntegerThreshold` and either `0` / `1` (the decimal counts themselves stay hardcoded — they are the "integer vs one-decimal" branches, not separate knobs).
  - Pass `{ width, fillGlyph, emptyGlyph }` from config into each `formatContextItem()` call.
  - In the `harness:start` adapter block (`index.ts:244`), gate the `registerStatusSlash` call on `config.slashCommandEnabled` and `registerStatusTool` on `config.toolEnabled`.
  - **No `watch()`.** All knobs are setup-time reads; changing decimals or bar glyphs at runtime is not worth the complexity. Document this in `CLAUDE.md` ("Invariants").

Files/lines to delete:

- The entire `## Configuration` section of `plugins/llm-status-items/README.md` (lines 64-87 today — file path, shape, computation note, malformed-JSON note). Replace with a short pointer: "Cost rates and a handful of display knobs are configured via `config:store` under the `llm-status-items` section of `~/.kaizen/harnesses/<key>/config.json`. See the per-field defaults in `config.ts`."
- The `## Cost table extensions` section of `plugins/llm-status-items/CLAUDE.md` (current lines 47-55). The `cost-table.json` file no longer exists; replace with a one-liner pointing at `config.costRates` and the schema.
- The `_testCostDeps` mention in `plugins/llm-status-items/CLAUDE.md` ("Testing" §) — tests inject the rate table via the standard config:store defaults pathway now.
- Any `test/cost.test.ts` / `test/index.test.ts` cases that exercise `loadRateTable` directly or set `_testCostDeps` — rework to feed `costRates` through the fake `ctx.useService("config:store")` shim.

## Manifest changes

`plugins/llm-status-items/package.json`:

- Add `"config:store"` to `services.consumes`. Topo-hint optional — matches the `useService`-with-graceful-fallback pattern used in INTEGRATION.md. Final list: `["events:vocabulary", "llm:complete", "config:store"]`.

Permissions:

- The current manifest declares `permissions: { tier: "unscoped" }` (in `index.ts`, no `permissions` block in `package.json`). The `unscoped` tier today exists *because* of the legacy cost-table file read in `cost.ts`. After migration that read disappears (config:store does the I/O inside `kaizen-config`'s permission boundary, per INTEGRATION.md's "Permissions" §).
  - Consider tightening the manifest to drop `unscoped` once the only consumer of that tier — `loadRateTable` — is gone. The remaining plugin code touches no FS, no network, no shell. Note this as a follow-up; the executor should verify there are no other unscoped reads I missed before flipping the tier.

## Risks / open questions

- **Migrating user data.** Any existing `~/.kaizen/plugins/llm-status-items/cost-table.json` is silently abandoned by this migration. Per INTEGRATION.md ("No backward-compat shims"), the user is expected to copy their rates into `config.json` by hand. Worth a single line in the release notes / `CLAUDE.md` so the executor surfaces it.
- **Glyph width.** The `contextBarFillGlyph` and `contextBarEmptyGlyph` schema bounds (`max: 4`) tolerate multi-codepoint glyphs but assume the user knows that a wide-cell glyph will misalign the bar. Schema can't enforce monospace width — keep the README note short ("must render in one cell").
- **`costRates` shape limits.** The `{ type: "object" }` field schema with `additionalProperties` is the only place the current contract surface comfortably models "arbitrary keys, fixed value shape". Worth confirming `kaizen-config`'s validator handles `additionalProperties: { type: "object", ... }` — `schema.ts` is the source of truth; if recursive schemas aren't fully supported, see the contract proposal below.
- **Cost feature toggle.** Today the cost item is *only* gated by "is the rate table non-empty?". I deliberately did **not** add a separate `costEnabled` boolean — users who want it off should simply clear `costRates`. Adding a redundant flag is dead weight.
- **No `watch()`.** Live reconfig of presentation knobs would require re-emitting every status item with the new format. Adds non-trivial complexity for marginal user value. Defer until someone asks.
- **Tier downgrade.** Tightening `permissions.tier` from `unscoped` is a behavior-affecting change for installer prompts. Keep that as a follow-up commit, not part of the migration itself.

## Contract proposals

None expected, but verify before implementing:

- The `costRates` field schema relies on `{ type: "object", additionalProperties: <FieldSchema> }`. The contract in `plugins/llm-contracts/contracts/config-store.ts` already lists `additionalProperties?: boolean | FieldSchema`, so this is supported on paper. If `kaizen-config`'s `schema.ts` validator does **not** in practice walk a `FieldSchema`-typed `additionalProperties` (e.g. it only honors the `boolean` form), append a proposal to `docs/config-migration/CONTRACTS-PROPOSALS.md` requesting that the validator recurse into typed-`additionalProperties` entries. Do not edit `llm-contracts` from this plan.
