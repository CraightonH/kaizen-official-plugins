# PLAN — `llm-mcp-bridge`

Consistency audit against `docs/config-migration/INTEGRATION.md` and the
`llm-axioms` canonical reference. The plugin is already wired into
`config:store`, but the integration deviates from the template in several
ways and the documentation still describes the pre-migration world.

## Current state

- `services.consumes` includes `"config:store"` (good).
- `index.ts` calls `cfgSvc.register<{ servers: Record<string, ServerConfig> }>(…)`
  with an **inline** defaults + schema, then `cfgSvc.get<…>("llm-mcp-bridge")`.
- No `config.ts` module — `DEFAULT_CONFIG` / `CONFIG_SCHEMA` are not extracted.
- `cfgSvc` is treated as required: there is no `if (cfgSvc)` guard and no
  try/catch around `register()`. The only ceremony is an explicit
  `ctx.consumeService("config:store")` before `ctx.useService(…)`.
- `process.env` is still read in `index.ts:55` but **only** to feed the
  plugin-specific `${env:VAR}` interpolation inside `servers.ts::resolveServers`
  — this is legitimate plugin behaviour, not a config knob.
- No `envVars` declared on the `ConfigSpec`.
- No `fs.read`/`fs.write` permissions declared in `package.json`.
- `ConfigSpec.plugin === "llm-mcp-bridge"` matches the manifest `name`.
- `package.json` has no `permissions` block in the manifest object proper
  (only the runtime `permissions: { tier: "unscoped" }` in `index.ts`); no
  legacy fs entries to remove.
- `README.md` still documents legacy file-based config (`~/.kaizen/mcp/servers.json`,
  `<cwd>/.kaizen/mcp/servers.json`, `${KAIZEN_MCP_CONFIG}`) — the migration
  removed those readers from code but not from the docs.
- `CLAUDE.md` references `envVars` overrides in passing (factually wrong
  post-migration; `envVars` is forbidden by `INTEGRATION.md`).

## Issues found

### Missed knobs

None of consequence. The bridge's tunables (`timeoutMs`, `healthCheckMs`,
`enabled`, `transport`) are already exposed per-server via the
`servers` map's `additionalProperties` schema. The fixed values in
`servers.ts` (default `timeoutMs = 30000`, default `healthCheckMs = 60000`)
and in `backoff.ts` (`RETRY_BUDGET = 5`, the 1s/2s/4s/8s/16s curve capped at
60s, the 5s status-bar tick in `index.ts`, the 5s stdio kill grace) are
documented invariants — `CLAUDE.md` explicitly says "If you change it,
update both `backoff.ts` and the README." Promoting them to config would
require schema work and is **not** required for consistency; leave as
plugin invariants unless the user asks for them.

`process.env` use in `index.ts:55` is **not** a config bypass — it is the
input to `${env:VAR}` interpolation, which is plugin-specific (and
documented in `CLAUDE.md`'s invariants). It does not need migrating.

### Pattern deviations

1. **No `config.ts` module.** Defaults + schema live inline in
   `index.ts:32-51`. `llm-axioms`, `INTEGRATION.md`'s template, and every
   other migrated plugin extract these to a small pure `config.ts`. This
   plugin should too.
2. **No `Object.freeze` on defaults.** The inline `defaults: { servers: {} }`
   object is not frozen. The template requires freezing (and spreading on
   the way into `register()`).
3. **No topo-hint-optional fallback.** `index.ts:31-32` reads:
   ```ts
   const cfgSvc = ctx.useService<ConfigStoreService>("config:store");
   cfgSvc.register<…>({ … });
   ```
   If `useService` returns `undefined` (fake `ctx` in tests, or
   `kaizen-config` not loaded in a custom harness), this throws. The
   `llm-axioms` template guards with `if (cfgSvc) { try { … } catch { … } }
   else { log("… unavailable; using DEFAULT_CONFIG"); }`.
4. **No try/catch around `register()`.** `register()` throws on
   double-registration (hot-reload during dev). The template wraps it and
   logs `… config:store register failed (<msg>); using defaults`.
5. **Explicit `ctx.consumeService("config:store")` call.** No other
   migrated plugin does this — `services.consumes` in the manifest is the
   declared mechanism, and `useService` is the runtime lookup. This call
   appears redundant; it does not appear in the `INTEGRATION.md` template
   or in `llm-axioms`. Either it has a load-bearing reason that should be
   commented, or it should be removed for consistency.
6. **`Record<keyof Config, FieldSchema>` shape.** The schema is `{ servers:
   { type: "object", additionalProperties: { … } } }` — fine on its own,
   but once extracted to `config.ts` it should be typed
   `Record<keyof McpBridgeConfig, FieldSchema>` per the template.
7. **No declared `envVars`.** Good — matches the migration rule.
8. **No legacy `fs.read`/`fs.write` permissions.** Good.
9. **`ConfigSpec.plugin` matches manifest `name`.** Good.

### Doc drift

1. **`README.md` "Configuration" section (lines 103-149) is stale.** It
   still says:
   - "Reads MCP server config from disk (project, user, and
     `${KAIZEN_MCP_CONFIG}` paths)" (line 7).
   - Files resolved from `~/.kaizen/mcp/servers.json`,
     `<cwd>/.kaizen/mcp/servers.json`, `${KAIZEN_MCP_CONFIG}` (lines 107-109).
   None of these paths exist in the codebase any more — config now lives
   under the `llm-mcp-bridge.servers` key in the shared harness config
   file. The schema example (lines 117-142) is still useful; the
   surrounding narrative needs to point at
   `~/.kaizen/harnesses/<key>/config.json` instead.
2. **`README.md` "Consumes" section omits `config:store`.** Lines 87-90
   list `tools:registry`, `events:vocabulary`, and `slash:registry`
   under "Services" but not `config:store`, even though the manifest
   declares it and the plugin will not boot without `cfgSvc.register`
   succeeding.
3. **`CLAUDE.md` invariant on `${env:VAR}` mentions "`envVars` overrides
   that `config:store` applies to top-level keys"** (line 55). Per
   `INTEGRATION.md`, env-var support is being removed from the config
   layer; the comparative reference is misleading. Either drop the
   comparison or rephrase it as "distinct from any future env-override
   mechanism on top-level config keys."
4. **`CLAUDE.md` module map for `index.ts`** (lines 8-10) says it "consumes
   `config:store`, registers schema" — accurate, but should also mention
   that defaults + schema will live in a new `config.ts` once extracted
   (see Proposed changes below).

## Proposed changes

1. **Extract `config.ts`.** Create
   `plugins/llm-mcp-bridge/config.ts` mirroring `llm-axioms/config.ts`:
   - `DEFAULT_CONFIG: McpBridgeConfig = Object.freeze({ servers: {} }) as McpBridgeConfig;`
   - `CONFIG_SCHEMA: Record<keyof McpBridgeConfig, FieldSchema> = { servers: { type: "object", properties: {}, additionalProperties: { … current shape … } } };`
2. **Add `McpBridgeConfig` to `public.d.ts`** as a plugin-private type:
   `export interface McpBridgeConfig { servers: Record<string, ServerConfig>; }`
   (or keep `ServerConfig` in `servers.ts` and re-export). Either is
   fine; pick whichever keeps the import graph shallow.
3. **Rewrite `setup()` registration block** to match the `INTEGRATION.md`
   template verbatim:
   ```ts
   let config: McpBridgeConfig = { ...DEFAULT_CONFIG };
   const cfgSvc = ctx.useService<ConfigStoreService>("config:store");
   if (cfgSvc) {
     try {
       cfgSvc.register<McpBridgeConfig>({
         plugin: "llm-mcp-bridge",
         defaults: { ...DEFAULT_CONFIG },
         schema: CONFIG_SCHEMA,
       });
       config = cfgSvc.get<McpBridgeConfig>("llm-mcp-bridge");
     } catch (e) {
       log(`llm-mcp-bridge: config:store register failed (${(e as Error).message}); using defaults`);
     }
   } else {
     log("llm-mcp-bridge: config:store unavailable; using DEFAULT_CONFIG");
   }
   ```
   `loadResolved()` then reads from `config` / re-`get`s through `cfgSvc`
   (current code re-`get`s on every `/mcp:reload`, which is correct for
   picking up edits — keep that pattern, but only if `cfgSvc` is present;
   otherwise fall back to `config.servers`).
4. **Remove the explicit `ctx.consumeService("config:store")` call** on
   line 29. `services.consumes` in the manifest already handles topo-sort,
   and `useService` handles runtime lookup. If there is a load-bearing
   reason (sub-agent should grep kaizen runtime for `consumeService` to
   confirm), keep it with a one-line comment explaining why.
5. **Update `README.md` "Configuration" section.** Replace the
   `~/.kaizen/mcp/servers.json` file resolution narrative with: "Config
   lives under the `llm-mcp-bridge.servers` key in the harness config
   file (`~/.kaizen/harnesses/<key>/config.json`, with project-layer
   override at `./.kaizen/harnesses/<key>/config.json`). See
   `docs/config-migration/INTEGRATION.md` for the layer model." Keep the
   schema example; drop the file-path enumeration.
6. **Update `README.md` "What it does"** (line 7): remove "and
   `${KAIZEN_MCP_CONFIG}` paths" and "(project, user, …)" — say "Reads
   MCP server config from `config:store` and resolves env interpolation
   (`${env:VAR}`)."
7. **Update `README.md` "Consumes › Services"** (lines 87-90): add
   `config:store` — required for boot (plugin still boots without it,
   but with an empty servers map and a log line).
8. **Update `CLAUDE.md` invariant on `${env:VAR}`** (line 55): drop the
   `envVars` comparison or rephrase to reflect that env-var overrides at
   the config layer are not currently supported.
9. **Update `CLAUDE.md` module map for `index.ts`** to mention `config.ts`
   alongside it.

## Risks / open questions

- **`ctx.consumeService("config:store")` semantics.** I do not know whether
  this is a no-op alias for the manifest declaration, a runtime gate that
  fails fast on misconfigured harnesses, or something else. The sub-agent
  executing this plan should `grep -r "consumeService" plugins/`
  + `grep -r "consumeService" node_modules/kaizen/` to confirm before
  deleting the call. If it is load-bearing, keep it and add a one-line
  comment; do not silently remove.
- **`loadResolved()` is called per-`/mcp:reload`** to pick up live edits
  (lines 53-58, 90-91). With the template's `if (cfgSvc)` guard, the
  fallback path must also work when `cfgSvc` is null: either resolve from
  `config.servers` (the snapshot taken at boot) or short-circuit reload
  with a log line. The latter is closer to "no config:store ⇒ nothing
  works dynamically" and matches the existing no-tools-registry path.
- **`cfgSvc.watch(…)`** is not currently used. The plugin reloads on
  explicit `/mcp:reload`. Per `INTEGRATION.md`, `watch()` is dead weight
  if not needed — and here it would race with the lifecycle state
  machine. Keep the current explicit-reload model; no change.
- **Promoting MCP server tunables out of `additionalProperties: true`.**
  The current schema has `additionalProperties: true` on each server
  entry (line 47) so undeclared fields (e.g. arbitrary handler hints)
  pass through. This is a deliberate "Claude-Code-compatible" shape.
  Tightening it would break user configs copy-pasted from Claude Code.
  Leave as-is.

## Contract proposals

None. The existing `FieldSchema` surface (string / number / boolean /
object with `additionalProperties` / enum) is sufficient for the
`servers` map. No changes to `llm-contracts` needed.
