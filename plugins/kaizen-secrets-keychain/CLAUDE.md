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
- **Service constant.** `kaizen-secrets`. Do not change without considering
  migration for existing users.

## Local deploy

Same recipe as the repo CLAUDE.md. Redeploy `llm-contracts` first if its
secrets-registry contract surface changed.
