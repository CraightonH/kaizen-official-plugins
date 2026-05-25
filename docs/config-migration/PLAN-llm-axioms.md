# PLAN-llm-axioms

Audit of `plugins/llm-axioms/` against
`docs/config-migration/INTEGRATION.md`. The plugin is held up as the
canonical reference in the integration guide; this plan only proposes
*additive* knob exposures and notes no pattern deviations.

## Current state

- No `process.env.*` reads anywhere in plugin source (verified via grep
  over `*.ts` excluding `node_modules`, `dist`, `test`).
- `DEFAULT_CONFIG` is `Object.freeze`d in `config.ts` and cast through
  `AxiomsConfig`.
- `CONFIG_SCHEMA` typed as `Record<keyof AxiomsConfig, FieldSchema>` —
  matches the "plain Record" precedent the integration guide endorses.
- `setup()` follows the canonical template line-for-line: local `log`
  helper, `useService<ConfigStoreService>("config:store")` topo-hint,
  try/catch around `register()` + `get()`, explicit fallback-to-defaults
  log when the service is absent.
- No `envVars` declared on the `ConfigSpec` (correctly omitted — env-var
  support is being dropped).
- `package.json` declares `"config:store"` in `services.consumes`.
- README and `CLAUDE.md` describe `config:store` integration accurately;
  no references to legacy per-plugin JSON files, no stale env-var
  documentation, no dead `fs.read`/`fs.write` permissions (manifest is
  `tier: unscoped`, no per-path entries).
- Plugin name in `ConfigSpec.plugin` (`"llm-axioms"`) matches manifest
  `name`.

Already-migrated knobs:
`axiomsDir`, `injectionByteCap`, `methodologyEnabled`,
`workspaceEnabled`, `staleTempMs`.

## Issues found

### Missed knobs

The following are plausibly tunable but currently hardcoded. None block
the plugin's "canonical example" status — each is additive and can be
deferred — but they are the only candidates the integration audit
identifies.

1. **Section priorities** (`index.ts:73`, `index.ts:80`).
   `llm-axioms:methodology` is registered at priority `50` and
   `llm-axioms:workspace` at `180`. INTEGRATION.md itself cites
   "rotating a section priority" as a textbook `watch()` use case
   (§ "Live updates: `watch()`"), implying priorities are expected to
   be tunable in a fully-migrated plugin. Today the user has no knob.

2. **Axiom-entry validation caps** (`schema.ts:8`, `schema.ts:24-28`).
   - `ID_RE` length cap `64` (regex `/^[a-z0-9_-]{1,64}$/`)
   - `MAX_STATEMENT = 280`
   - `MAX_PREMISE = 500`
   - `MAX_PREMISES = 10`
   - `MAX_REASONING = 2000`
   - `MAX_SCOPE = 200`

   These are user-observable (a longer reasoning string causes
   `reasoning_too_long`) and are exactly the "hardcoded tunable
   constants the user might want to control" pattern the integration
   guide flags. Caveat: README documents the current limits as part of
   the public service contract ("Ids must match `[a-z0-9_-]{1,64}`.
   `statement` ≤ 280 chars; …"). Exposing them as config means the
   documented limits become defaults, not absolutes — call this out in
   any future plan.

### Pattern deviations

None. Every checklist item from INTEGRATION.md § "The canonical plugin
layout" is satisfied:

- Frozen `DEFAULT_CONFIG`: yes (`config.ts:4`).
- `CONFIG_SCHEMA` typed as `Record<keyof AxiomsConfig, FieldSchema>`:
  yes (`config.ts:15`).
- `setup()` uses topo-hint `useService` + fallback-to-defaults log:
  yes (`index.ts:43-57`).
- `register()` wrapped in try/catch with fallback log: yes
  (`index.ts:45-54`).
- No `envVars` declared: confirmed.
- `"config:store"` in `services.consumes`: confirmed
  (`package.json` / manifest in `index.ts:29-35`).
- Plugin name in `ConfigSpec.plugin` matches manifest name: confirmed.

### Doc drift

None observed.

- README "Configuration" table enumerates the five migrated keys with
  current defaults and accurate notes.
- README "Consumes" section explicitly labels `config:store` as
  "topo-hint optional; falls back to `DEFAULT_CONFIG` if absent."
- `CLAUDE.md` "Module map" entry for `config.ts` matches the current
  file contents ("DEFAULT_CONFIG (frozen) + CONFIG_SCHEMA for
  config:store").
- No surviving references to legacy env vars, legacy per-plugin JSON
  config files, or `fs.read`/`fs.write` paths.

## Proposed changes

All proposals are **deferrable**. The plugin remains a valid canonical
reference today.

1. **Expose section priorities as config (recommended).**
   Add two integer fields:
   - `methodologyPriority: number` (default `50`)
   - `workspacePriority: number` (default `180`)

   Schema: `{ type: "number", min: 0, integer: true }`. Wire them into
   the `prompt:registry` `register({ priority: … })` calls. If
   ergonomic, add `cfgSvc.watch()` to re-register sections on change
   (otherwise document that the user must restart the harness).
   Rationale: aligns the canonical example with the `watch()` example
   in INTEGRATION.md.

2. **Expose axiom-entry validation caps as config (optional).**
   Add an `axiomLimits` object field:
   ```ts
   axiomLimits: {
     idMaxLen: number;        // default 64
     statementMaxLen: number; // default 280
     premiseMaxLen: number;   // default 500
     premisesMaxCount: number;// default 10
     reasoningMaxLen: number; // default 2000
     scopeMaxLen: number;     // default 200
   }
   ```
   Schema: `{ type: "object", properties: { … }, additionalProperties: false }`
   with each leaf `{ type: "number", min: 1, integer: true }`. Pass the
   resolved limits into `schema.ts` (refactor `validateAxiomEntry` to
   take limits as an argument, or close over a module-scoped setter
   that `setup()` invokes once with `config.axiomLimits`).

   Note: `ID_RE` is a regex with the cap baked in. Exposing `idMaxLen`
   means building the regex at validate-time
   (`new RegExp(`^[a-z0-9_-]{1,${idMaxLen}}$`)`) — small perf hit,
   trivial code change.

   Also update the README "Adding an axiom writer from another plugin"
   section in `CLAUDE.md` to phrase the limits as "defaults (tunable
   via config)".

3. **No other changes.** Do not touch the integration patterns
   themselves — they are the reference.

## Risks / open questions

- **Documented limits as contract.** The current README/CLAUDE.md
  language treats the schema-validation caps as part of the
  `axioms:registry` service contract surface. Exposing them as config
  weakens that contract for downstream consumers (any plugin calling
  `axioms.record(…)` cannot assume a 280-char statement will succeed).
  Decide whether the limits are a service-level invariant (keep
  hardcoded) or user-level policy (migrate to config) before doing
  proposal 2.
- **Section priority changes mid-session.** If proposal 1 is wired
  through `watch()`, re-registering a prompt section means
  unregister + register with the new priority, which bumps generation
  and may flush prompt caches. Acceptable, but worth a one-line note
  in `CLAUDE.md`.
- **`config:store` `register()` is one-shot.** Both proposals expand
  the schema, which means the user's existing
  `~/.kaizen/harnesses/<key>/config.json` keeps working (missing fields
  fall back to defaults). No migration step needed for users.
- **`watch()` not currently used.** Today the plugin reads config once
  in `setup()`. Adding `watch()` for proposal 1 is the first watcher in
  this plugin — wire teardown via the existing `plugin.stop()` so
  unsubscribe runs on harness shutdown.

## Contract proposals (only if needed)

None. The existing `FieldSchema` surface (`number` with `min`/`integer`,
nested `object` with `properties` + `additionalProperties`) covers both
proposals above without any extension. No append to
`docs/config-migration/CONTRACTS-PROPOSALS.md` is required.
