# PLAN: `openai-llm` consistency pass

## Current state

`openai-llm` already routes its config through `config:store` (INTEGRATION.md
cites it as the secrets example) but its `index.ts` deviates from the canonical
`llm-axioms` shape in several ways:

- Defaults + schema are split: `defaults.ts` exports a frozen `DEFAULT_CONFIG`
  but there is no `config.ts`, and the `FieldSchema` literal is inlined into
  `register()` instead of living next to the defaults.
- `register()` is called unconditionally without try/catch and without the
  topo-hint-optional fallback to `DEFAULT_CONFIG`.
- The spec declares `envVars: { apiKey: "OPENAI_API_KEY" }` — INTEGRATION.md
  forbids `envVars`.
- The `apiKey` field is **not** declared `secret: true`, contradicting the
  INTEGRATION.md "Secret fields" section that names this plugin as the
  example.
- No `await cfgSvc.ready()` before reading `apiKey`, so the first `get()` can
  return the `$ref` pointer instead of the plaintext once secret support is on.
- `setup()` calls `ctx.consumeService(...)` explicitly (legacy pattern; the
  declarative `services.consumes` already covers this).
- README still documents legacy `KAIZEN_OPENAI_LLM_CONFIG` /
  `~/.kaizen/plugins/openai-llm/config.json` / `apiKeyEnv` paths that the
  current code no longer implements.
- CLAUDE.md references a `config.ts` file that does not exist.

`process.env.KAIZEN_DEBUG_REQUESTS` in `http.ts` is the only remaining env
read; treat it as an opt-in debug toggle, not config (borderline — see open
questions).

## Issues found

### Missed knobs

- **`apiKey` secret flag missing.** Schema entry is `{ type: "string" }`; per
  INTEGRATION.md it must be `{ type: "string", secret: true, min: 1 }` (or
  `min: 1` only when the user has actually set a value — see open questions
  re: empty-default vs. `min: 1`).
- **No `await cfgSvc.ready()` before `get()`.** With `secret: true`, the first
  `get()` may yield a `{ $ref: ... }` pointer; `makeService(cfg, …)` captures
  that pointer for the lifetime of the service. Must await `ready()` before
  reading.
- **`envVars: { apiKey: "OPENAI_API_KEY" }`** — explicitly disallowed by
  INTEGRATION.md "What this migration does NOT do". Drop the field.
- **`KAIZEN_DEBUG_REQUESTS`** in `http.ts` is an env read, but it's a
  developer debug switch writing files under `~/.kaizen/debug/`. Could become
  a `debugRequests: boolean` config field for consistency; see open questions.
- No other hardcoded tunables: `VERSION` is a build-time string, the
  `/chat/completions` and `/api/v0/models` paths are protocol constants, and
  request shape is contract-driven.

### Pattern deviations

- **No `config.ts`.** `llm-axioms` colocates `DEFAULT_CONFIG` and
  `CONFIG_SCHEMA` in one pure module. Here, defaults live in `defaults.ts`
  and the schema is inlined in `index.ts`. Consolidate into
  `plugins/openai-llm/config.ts` exporting both, typed as
  `Record<keyof OpenAILLMConfig, FieldSchema>`.
- **No topo-hint-optional fallback in `setup()`.** Current code does
  `ctx.useService<ConfigStoreService>("config:store")` and then calls
  `.register()` on the result without checking for `undefined` and without a
  try/catch. Tests that pass a bare fake `ctx` will crash. Mirror the
  `llm-axioms` shape: `if (cfgSvc) { try { register + get } catch { log,
  defaults } } else { log, defaults }`.
- **Explicit `ctx.consumeService("events:vocabulary")` and
  `ctx.consumeService("config:store")` calls.** Neither `llm-axioms` nor any
  other migrated plugin uses these — the declarative `services.consumes` is
  the contract. Remove both lines.
- **`DEFAULT_CONFIG` cast `as` not necessary** at the type-assertion site
  but `llm-axioms` uses `as AxiomsConfig` after the `Object.freeze(...)` for
  the same reason — keep the pattern consistent (`as OpenAILLMConfig`).
- **`VERSION` constant duplicated** between `index.ts` (`"0.1.1"`) and
  `package.json` (`"0.1.1"`). Not a config issue but a consistency
  smell — out of scope for this plan, noting only.
- Manifest `services.consumes` already lists `"config:store"` (good).
  `ConfigSpec.plugin` is `"openai-llm"`, matching manifest `name` (good).
- No legacy `fs.read` / `fs.write` permissions to drop (`tier: "unscoped"`
  covers everything).

### Doc drift

- **README "Configuration" section** documents:
  - `KAIZEN_OPENAI_LLM_CONFIG` env var → no longer implemented
  - `~/.kaizen/plugins/openai-llm/config.json` per-plugin file → superseded
    by the harness `config.json`
  - `apiKeyEnv` field → not in `OpenAILLMConfig`
  - Permissions bullet "Reads config from the user's home directory or an
    arbitrary override path" / "Reads environment variables for config" →
    stale
  Rewrite to describe `config:store` integration and the secret-ref behavior
  for `apiKey`.
- **README "Services" / "Consumes"** lists only `events:vocabulary`; should
  also list `config:store` to match manifest.
- **CLAUDE.md File Map** says `config.ts owns the JSON config file shape and
  validation` — that file does not exist today. Update once `config.ts` is
  introduced (this plan creates it).

## Proposed changes

1. **Create `plugins/openai-llm/config.ts`** with:
   - `export const DEFAULT_CONFIG: OpenAILLMConfig = Object.freeze({ … }) as OpenAILLMConfig;`
     (move the body from `defaults.ts`).
   - `export const CONFIG_SCHEMA: Record<keyof OpenAILLMConfig, FieldSchema> = { … };`
     including `apiKey: { type: "string", secret: true }`.
   - Delete `defaults.ts` and re-point the `index.ts` import.
2. **Rewrite `setup()`** to mirror `llm-axioms`:
   - Drop the two `ctx.consumeService(...)` calls.
   - `let config: OpenAILLMConfig = { ...DEFAULT_CONFIG, retry: { ...DEFAULT_CONFIG.retry }, extraHeaders: { ...DEFAULT_CONFIG.extraHeaders } };`
   - `const cfgSvc = ctx.useService<ConfigStoreService>("config:store");`
   - `if (cfgSvc) { try { cfgSvc.register(...); await cfgSvc.ready(); config = cfgSvc.get<OpenAILLMConfig>("openai-llm"); } catch (e) { log(...) } } else { log(...) }`
   - Drop the `envVars` field from the spec.
   - Pass `config` (not `cfg`) into `makeService(...)`.
3. **README rewrite** (Configuration + Services + Permissions sections) per
   the doc-drift list above. Mirror the wording style used in
   `plugins/llm-axioms/README.md` for the config section.
4. **CLAUDE.md File Map**: change the `config.ts` line to describe the new
   defaults + schema module, and remove the "owns the JSON config file shape
   and validation" wording.

## Risks / open questions

- **`apiKey` schema `min`.** `DEFAULT_CONFIG.apiKey = ""` (LM Studio doesn't
  require a key). INTEGRATION.md's example uses `min: 1`. Combining
  `default: ""` with `min: 1` would fail validation on boot for users who
  haven't set a key and silently revert to defaults — i.e., no-op. Recommend
  **omit `min`** for `apiKey` here (deviates from INTEGRATION.md's snippet,
  but matches this plugin's "empty key is valid for local LM Studio" reality).
  Note this in CLAUDE.md so the next reader doesn't "fix" it.
- **`await ready()` placement.** If `ready()` blocks on secrets-registry
  boot and `openai-llm` setup runs before `secrets:registry` provider
  setup, this could deadlock. Today the secrets registry lives in
  `kaizen-config`'s boot path so `await ready()` should resolve fine, but
  worth a manual smoke test (`kaizen --harness ./harnesses/local.json` with
  an `apiKey` set).
- **`KAIZEN_DEBUG_REQUESTS` in `http.ts`.** Migrating this to a
  `debugRequests: boolean` config field is the consistent move, but it would
  also force the `http.ts` module to take a config arg (it currently reads
  `process.env` directly). Borderline — recommend **leave as env var for now**
  and revisit if/when a debug-namespace config field is added across plugins.
  Document the env-var holdout in CLAUDE.md so it doesn't look like an
  oversight.
- **`extraHeaders` `additionalProperties`.** Current schema uses
  `{ type: "object", properties: {}, additionalProperties: { type: "string" } }`.
  That is the right shape per the `FieldSchema` union, but worth confirming
  the store actually honors `additionalProperties: FieldSchema` validation
  for arbitrary string keys; if it only honors the `boolean` form, drop to
  `additionalProperties: true`. No change proposed pending a store-side
  check.

## Contract proposals (only if needed)

None. The `secret: true` flag on `string` fields and the `ready()` method are
already in `llm-contracts/contracts/config-store.ts`; this plan is purely a
consumer-side fix.
