# Working in `llm-config`

Notes for agents editing this plugin. See the design spec at
`docs/superpowers/specs/2026-05-18-llm-config-design.md`.

## Invariants

- **Single file per harness.** Reads/writes target
  `~/.kaizen/harnesses/<harnessKey>/config.json` (home) and
  `<cwd>/.kaizen/harnesses/<harnessKey>/config.json` (project, keys win).
  Never write to per-plugin paths.
- **Atomic writes only.** `atomic-write.ts` is the sole writer; tmp+rename.
- **Schema validation is mandatory on every load + every write.** A
  validation failure on boot logs and falls back to defaults; a failure
  on `set()` rejects the call.
- **Env-var values beat all file layers.** Documented; consumers can
  declare per-field `envVars` mappings via `register()`.
- **`store.ts`, `paths.ts`, `schema.ts`, `envvars.ts`, `atomic-write.ts`
  must remain pure** (deps-injected I/O). Only `index.ts` and `slash.ts`
  touch `ctx`.

## Local deploy

Same recipe as the repo CLAUDE.md, plus: redeploy `llm-contracts` first if
this plugin's contract surface changed.
