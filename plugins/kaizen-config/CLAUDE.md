# Working in `kaizen-config`

Notes for agents editing this plugin. See the design spec at
`docs/superpowers/archive/specs/2026-05-18-llm-config-design.md` and the
consumer-facing integration guide at
`docs/config-migration/INTEGRATION.md` (this plugin's own self-registration
follows that guide).

## Self-registered fields

`config.ts` holds the frozen `DEFAULT_CONFIG` and `CONFIG_SCHEMA` for the
plugin's own `register()` call. Two optional fields:

- `defaultSecretBackend?: string` — consulted by `selectBackend` when a
  secret field is set with multiple writable backends available.
- `editor?: string` — used by `/config:edit`; falls back to
  `process.env.EDITOR ?? "vi"` at invocation time when unset.

Both fields are intentionally omitted from `DEFAULT_CONFIG` (rather than
carried as `undefined`), so they don't appear in `/config:list` resolution
output until the user actually sets them. Do not re-inline the schema in
`index.ts` — edit `config.ts` instead.

## Invariants

- **Single file per harness.** Reads/writes target
  `~/.kaizen/harnesses/<harnessKey>/config.json` (home) and
  `<cwd>/.kaizen/harnesses/<harnessKey>/config.json` (project, keys win).
  Never write to per-plugin paths.
- **Atomic writes only.** `atomic-write.ts` is the sole writer; tmp+rename.
- **Schema validation is mandatory on every load + every write.** A
  validation failure on boot logs and falls back to defaults; a failure
  on `set()` rejects the call.
- **Env-var resolution is legacy.** `envvars.ts` and the store's env
  override path still work for backward compatibility, but new plugins
  must **not** declare `envVars` on their `ConfigSpec` —
  `docs/config-migration/INTEGRATION.md` is the policy. The env *secret*
  scheme (`env:VAR_NAME` via `secrets:registry`) is the supported way to
  pull values from the environment.
- **`store.ts`, `paths.ts`, `schema.ts`, `envvars.ts`, `atomic-write.ts`
  must remain pure** (deps-injected I/O). Only `index.ts` and `slash.ts`
  touch `ctx`.

## Local deploy

Same recipe as the repo CLAUDE.md, plus: redeploy `llm-contracts` first if
this plugin's contract surface changed.
