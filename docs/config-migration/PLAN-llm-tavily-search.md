# PLAN: `llm-tavily-search` config consistency audit

Plan-only. No code, no git. Compares the already-integrated plugin against
`docs/config-migration/INTEGRATION.md`, `plugins/llm-axioms/{index.ts,config.ts}`
(canonical), and `plugins/openai-llm/index.ts` (secret-field reference).

## Current state

- `index.ts` registers a `ConfigSpec<TavilyConfig>` with `config:store` and
  reads merged config synchronously in `setup()`.
- `defaults.ts` exports a frozen `DEFAULT_CONFIG: TavilyConfig`.
- Schema is **inlined in `index.ts`** (no `config.ts`, no exported
  `CONFIG_SCHEMA`).
- `apiKey` is treated as a plain string field with `envVars: { apiKey: "TAVILY_API_KEY" }`.
- `config:store` is in `services.consumes`. `ConfigSpec.plugin` ("llm-tavily-search")
  matches manifest `name`. No `fs.read`/`fs.write` permissions in the manifest.
- `setup()` throws on missing `config:store` (and on missing `tools:registry`).
- `tool.ts` is pure; reads only from injected `config`. No `process.env` reads.

## Issues found

### Missed knobs

None outstanding. All tunables already in `TavilyConfig`:

- `apiKey`, `endpoint`, `defaultMaxResults`, `defaultSearchDepth`,
  `defaultIncludeAnswer`, `requestTimeoutMs`.

No `process.env.*` reads remain in `index.ts` or `tool.ts`. No custom-file
readers (no `KAIZEN_TAVILY_CONFIG` reader exists in code — only stale README
text mentions it).

Borderline:

- README documents a phantom `apiKeyEnv` config field that does not exist in
  the type or schema. Dead docs, not a missed knob.

### Pattern deviations (vs. `llm-axioms` / `openai-llm`)

1. **`envVars` is declared.** `INTEGRATION.md` is explicit: **"do not declare
   `envVars` on the `ConfigSpec`"**. Remove
   `envVars: { apiKey: "TAVILY_API_KEY" }` from the spec.

2. **`apiKey` is not marked `secret: true`.** This is the load-bearing
   miss for a credential field. Compare `openai-llm` (which also lacks
   `secret: true` today — separate problem) against the `INTEGRATION.md`
   "Secret fields" guidance: API keys must be
   `{ type: "string", secret: true, min: 1 }` so the store routes them through
   `secrets:registry` and persists only a `$ref` pointer in
   `config.json`. Without `secret: true`, the raw key sits in plaintext on
   disk.

3. **Schema not in `config.ts`, not typed `Record<keyof TavilyConfig, FieldSchema>`.**
   Canonical pattern (`llm-axioms/config.ts`) co-locates `DEFAULT_CONFIG` and
   `CONFIG_SCHEMA` in a single pure module with the explicit
   `Record<keyof Config, FieldSchema>` type. Today `defaults.ts` holds only
   defaults and the schema is an inline object literal in `index.ts`.

4. **`setup()` is not topo-hint optional with fallback.** Current code:
   ```ts
   if (!cfgSvc) throw new Error("llm-tavily-search: config:store service not available");
   ```
   Canonical pattern logs and falls back to `DEFAULT_CONFIG`. `config:store`
   boots early so absence is rare, but the fallback keeps plugin lifecycle
   tests working without spinning up the store. `tools:registry` may
   reasonably stay a hard requirement (the plugin's only job is to register
   the `web_search` tool), but `config:store` should not be.

5. **No `try/catch` around `register()`.** Double-registration on hot-reload
   throws. `llm-axioms` and `INTEGRATION.md` wrap `register()` + `get()` in
   try/catch and log on failure.

6. **No `await cfgSvc.ready()` before reading the secret.** Per
   `INTEGRATION.md`: *"Before `ready()`, you may see the `$ref` pointer
   itself — defer secret-dependent work until `await cfgSvc.ready()`
   resolves."* The `apiKey` warning log at line 44–49 and the eventual
   tool-call all depend on the resolved plaintext. Without an `await
   cfgSvc.ready()` between `register()` and `get()`, the first call could
   receive a `$ref` object and the "no API key found" branch would mis-fire
   (or the handler would POST `{ "$ref": "..." }` as `api_key`).

7. **`ctx.consumeService(...)` calls are vestigial.** `useService` already
   carries the topo hint via the manifest `consumes` array. `llm-axioms`
   and `openai-llm` (mostly) use `useService` directly. Low-impact, but
   delete for consistency.

### Doc drift

`README.md`:

- "Setup" section instructs `export TAVILY_API_KEY=tvly-...` as the
  recommended path. Env-var support has been removed from the migration;
  recommended path is now `/config:set llm-tavily-search apiKey=<key>`.
- "Or config file at `~/.kaizen/plugins/llm-tavily-search/config.json`" —
  wrong location. New home is
  `~/.kaizen/harnesses/<harnessKey>/config.json` under
  `plugins["llm-tavily-search"]`.
- "If `apiKey` is empty, the environment variable named by `apiKeyEnv` …"
  references a config field that does not exist.
- Configuration table lists a phantom `apiKeyEnv` row.
- `KAIZEN_TAVILY_CONFIG` is documented but not implemented anywhere in
  source. Drop.
- "Permissions" section claims the plugin reads config from the user's home
  directory and reads the `TAVILY_API_KEY` env var. After migration this is
  false — config reads go through `config:store` and live inside
  `kaizen-config`'s permission boundary.

`CLAUDE.md`:

- "API key plumbing comes from `config:store` (`envVars: { apiKey:
  "TAVILY_API_KEY" }`)." Will be inaccurate once `envVars` is removed.
- "Config location … Override with `TAVILY_API_KEY` env var (beats file
  values)" — same.

## Proposed changes

1. **Add `plugins/llm-tavily-search/config.ts`** following the `llm-axioms`
   template: re-export the frozen `DEFAULT_CONFIG` (move from `defaults.ts`
   or re-export it) plus
   `CONFIG_SCHEMA: Record<keyof TavilyConfig, FieldSchema>` with
   `apiKey: { type: "string", secret: true, min: 1 }`. Keep the other
   field schemas as-is (they look correct: enum on `defaultSearchDepth`,
   integer/min/max on `defaultMaxResults`, etc.). Either delete `defaults.ts`
   and let `config.ts` own both, or have `config.ts` import and re-export
   from `defaults.ts` — prefer the former to match `llm-axioms`.

2. **Rewrite `setup()` registration block to match `llm-axioms`:**
   - `useService<ConfigStoreService>("config:store")`; if absent, log
     `"llm-tavily-search: config:store unavailable; using DEFAULT_CONFIG"`
     and proceed with `config = { ...DEFAULT_CONFIG }`.
   - Wrap `register()` + `get()` in try/catch, log
     `"llm-tavily-search: config:store register failed (…); using defaults"`
     on throw, and fall back to defaults.
   - Drop `envVars: { apiKey: "TAVILY_API_KEY" }`.
   - **Call `await cfgSvc.ready()` between `register()` and the first
     `get()`** so the secret resolves to plaintext.
   - Drop the two `ctx.consumeService(...)` calls (redundant with manifest).

3. **Update the "no API key" log** to drop the
   `Set TAVILY_API_KEY or …` half — surviving advice is just
   `/config:set llm-tavily-search apiKey=<key>`.

4. **Refresh docs:**
   - `README.md`: rewrite "Setup", "Configuration", and "Permissions"
     sections; remove `apiKeyEnv`, `KAIZEN_TAVILY_CONFIG`, the legacy
     `~/.kaizen/plugins/llm-tavily-search/config.json` path, and the
     `TAVILY_API_KEY` recommendation. State that the api key is a secret
     field — plaintext is stashed in `secrets:registry` and only a `$ref`
     pointer lives in `config.json`.
   - `CLAUDE.md`: replace the `envVars` mention with the secret-field
     pattern; drop the `TAVILY_API_KEY` override note.

5. **Tests:** `test/scaffold.test.ts` and `test/tool.test.ts` likely stub
   a fake `ctx` and bypass `config:store`. With the topo-hint-optional
   fallback the scaffold test should keep working; verify and update the
   "expects config:store to be present" assertion if one exists. No new
   tests required for `secret: true` (the contract behavior is owned by
   `kaizen-config`).

## Risks / open questions

- **Secret-store availability.** If the local harness's `secrets:registry`
  is not wired (or is wired to a backend that can't store the value), does
  `register()` of a `secret: true` field throw, or does the store silently
  fall back to plaintext? Behavior should be confirmed against
  `kaizen-config/store.ts` before flipping the bit, so users with a freshly
  upgraded harness don't see the plugin fail to load. If the store currently
  requires a backend, document the prerequisite in the README.
- **`ready()` timing.** If `await cfgSvc.ready()` blocks for the duration
  of secret-backend resolution, plugin setup latency goes up. For the local
  harness with the keychain backend on macOS this should be sub-100ms, but
  worth confirming.
- **Existing user configs.** Users who have already set `apiKey` as a
  plaintext string via `/config:set` will have a plaintext value in
  `config.json`. Flipping `secret: true` does not migrate existing values;
  the user must re-set the key (or `kaizen-config` performs an
  on-read-rewrite — verify which). Note in the README.
- **`openai-llm` parallel.** `openai-llm` also fails the `secret: true`
  test for its `apiKey` field. Out of scope for this plugin, but flagging
  in case the leader wants to schedule a paired follow-up.

## Contract proposals

None. The `FieldSchema` surface already supports
`{ type: "string", secret: true }`, and `ConfigStoreService.ready()` is
already on the contract. No additions to
`docs/config-migration/CONTRACTS-PROPOSALS.md` needed.
