# Working in `kaizen-secrets-keychain`

Notes for agents editing this plugin. See the design spec at
`docs/superpowers/specs/2026-05-20-kaizen-config-secrets-design.md`.

## Invariants

- **No native deps.** All Keychain access is via `child_process.spawn`
  against the system `security` CLI. Do not add `keytar` or similar.
- **Pure resolver factory.** `resolver.ts` exports `(spawn) => SecretsResolver`
  so tests can inject a fake `spawn`. `index.ts` is the only file that
  touches `ctx` or `process`.
- **Platform guard.** `index.ts` bails on non-darwin platforms with a log
  line and returns cleanly. Tests assert this.
- **Service constant.** Default `kaizen-secrets`, configurable via
  `config:store` field `keychainService` (see `config.ts`). Changing it
  orphans existing entries — handle migration manually. Read once at
  `setup()`; no `watch()` (re-registering the resolver under a new svce
  mid-session would silently orphan in-flight reads). Restart kaizen to
  pick up changes.

## Local deploy

Same recipe as the repo CLAUDE.md. Redeploy `llm-contracts` first if its
secrets-registry contract surface changed.
