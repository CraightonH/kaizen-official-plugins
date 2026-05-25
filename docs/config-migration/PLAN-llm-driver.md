# Migration plan: llm-driver

## Current state

- No `process.env.*` reads anywhere in the plugin (verified across
  `index.ts`, `loop.ts`, `cancel.ts`, `state.ts`, `ids.ts`,
  `busy-messages.ts`, `done-messages.ts`).
- No custom config-file readers (no `readFileSync`/`readFile` against
  `~/.kaizen/plugins/llm-driver/...` or anywhere else).
- Single existing config knob, declared via the legacy
  `KaizenPlugin.config` manifest mechanism (not `config:store`):
  - `plugins/llm-driver/index.ts:17-19` — `interface DriverConfig { defaultSystemPrompt?: string }`
  - `plugins/llm-driver/index.ts:21-23` — `DEFAULTS = { defaultSystemPrompt: "" }`
  - `plugins/llm-driver/index.ts:62-74` — `plugin.config = { schema, defaults }` (legacy kaizen plugin-config block)
  - `plugins/llm-driver/index.ts:167` — read inside `buildDeps()` via
    `(ctx.config as DriverConfig)?.defaultSystemPrompt`
  - `plugins/llm-driver/index.ts:188-189` — re-read in `start()` via
    `cfg.defaultSystemPrompt ?? DEFAULTS.defaultSystemPrompt`
- README documents this one knob explicitly under "Configuration".
- Hardcoded constants reviewed and intentionally **not** migrated:
  - `BUSY_MESSAGES` (`busy-messages.ts`) — cosmetic flavor pool.
  - `DONE_MESSAGES` (`done-messages.ts`) — cosmetic flavor pool.
  - `turn_` id prefix and uuid format (`ids.ts`) — internal identifier
    shape; not user policy.
  - Output whitespace trim and blank-line padding (`index.ts:245-256`) —
    TUI layout, internal policy.
  - LLM stream event names, deepFreeze depth, assemblyCache WeakMap —
    runtime mechanics, not knobs.

## Proposed `LlmDriverConfig`

```ts
export interface LlmDriverConfig {
  defaultSystemPrompt: string; // Fallback system prompt when prompt:registry is not bound. Default: "".
}
```

## Defaults and schema

| Field | Default | FieldSchema |
|---|---|---|
| `defaultSystemPrompt` | `""` | `{ type: "string" }` |

`Object.freeze` the `DEFAULT_CONFIG` per the INTEGRATION.md template.

## Code changes

- Edit `plugins/llm-driver/public.d.ts`:
  - Add `export interface LlmDriverConfig { defaultSystemPrompt: string; }`.
  - Keep the existing re-exports of contract types untouched.
- Add `plugins/llm-driver/config.ts`:
  - Export `DEFAULT_CONFIG: LlmDriverConfig` (frozen) with
    `defaultSystemPrompt: ""`.
  - Export `CONFIG_SCHEMA: Record<keyof LlmDriverConfig, FieldSchema>`
    with `{ defaultSystemPrompt: { type: "string" } }`.
- Edit `plugins/llm-driver/index.ts`:
  - Add imports for `ConfigStoreService` from `llm-contracts/public`,
    `LlmDriverConfig` from `./public.d.ts`, and `DEFAULT_CONFIG` /
    `CONFIG_SCHEMA` from `./config.ts`.
  - Delete the inline `interface DriverConfig` (lines 17-19) and the
    inline `DEFAULTS` object (lines 21-23).
  - Delete the legacy `plugin.config = { schema, defaults }` block on
    lines 62-74 — the legacy kaizen plugin-config mechanism is replaced
    by `config:store`.
  - In `setup()`, add the topo-hint optional `config:store` lookup +
    `register()` + `get()` per the INTEGRATION.md template, populating a
    module-scope `config: LlmDriverConfig`. Fall back to a spread of
    `DEFAULT_CONFIG` if the service is missing or `register()` throws.
  - Reset `config = { ...DEFAULT_CONFIG }` on every `setup()` alongside
    the existing state reset block (state lines 96-101).
  - Update `buildDeps()` (line 167) so the `defaultSystemPrompt`
    fallback chain becomes
    `state.systemPrompt || config.defaultSystemPrompt`. Drop the
    `(ctx.config as DriverConfig)?.defaultSystemPrompt` lookup and the
    final `DEFAULTS.defaultSystemPrompt` rung — `config.defaultSystemPrompt`
    is always populated.
  - Update `start()` (lines 188-189) to read
    `state.systemPrompt = config.defaultSystemPrompt;` (drop the
    `ctx.config` cast and the `DEFAULTS` fallback).
- No changes to `loop.ts`, `cancel.ts`, `state.ts`, `ids.ts`,
  `busy-messages.ts`, or `done-messages.ts`.
- No `watch()` subscription — `defaultSystemPrompt` is only meaningful
  before the first turn (and is superseded by `prompt:registry` when
  bound). Live-updating it mid-session would be confusing and is dead
  weight here.

## Manifest changes

`plugins/llm-driver/package.json` has no `services` block today — the
service wiring lives in `index.ts` (`plugin.services.consumes` /
`plugin.services.provides`). The actual edit is to that array in
`index.ts`:

- Add `"config:store"` to `services.consumes` (topo-hint optional —
  declared but not passed to `ctx.consumeService`). Existing hard edges
  (`events:vocabulary`, `ui:channel`, `llm:complete`, `sessions:store`)
  are unchanged.
- No permission changes. Plugin is `tier: "unscoped"` and does no FS I/O
  of its own; nothing to remove.

## Risks / open questions

- The legacy `plugin.config` block (lines 62-74) is what kaizen reads to
  populate `ctx.config` today. Deleting it should be safe because we
  switch every reader to the new `config` variable in the same change,
  but verify with `cd plugins/llm-driver && bun test` and
  `kaizen plugin validate plugins/llm-driver` after the edit. Existing
  tests pass a fake `ctx` and won't exercise the legacy plugin-config
  path.
- `state.systemPrompt` is mutated by the `session:handoff` path
  indirectly (via `buildDeps()` reading it) and is also re-seeded in
  `start()`. The migration preserves this dual-write — the new `config`
  is the seed value, `state.systemPrompt` remains the live mutable
  override surface.
- `setup()` and `start()` receive different `ctx` objects (documented
  invariant). Register/get `config` in `setup()`; do not re-fetch from
  `config:store` in `start()` (the variable closed over by `buildDeps()`
  is already correct). `start()` just reads the captured `config`
  variable when seeding `state.systemPrompt`.
- `register()` is one-shot per harness boot. The template's try/catch
  guard already handles the double-register case from dev hot-reloads;
  apply the same pattern here.

## Contract proposals

None. `LlmDriverConfig` is plugin-private (no other plugin needs to
import it), and the existing `FieldSchema` / `ConfigStoreService`
surface in `llm-contracts/public` is sufficient.
