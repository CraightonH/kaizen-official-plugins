# TODO

## Finish env-var support in kaizen-config

**Background.** The 2026-05 config migration (commits `634e135`, `064c2bd`)
deleted every direct `process.env.*` config read across all plugins and
intentionally did **not** declare `envVars` mappings on any `ConfigSpec`.
The misleading framing at the time was "env vars are buggy" — they aren't.
`kaizen-config` has had a first-class env-var override path
(`envvars.ts`, `applyEnvOverrides`) since the plugin existed, and it works
correctly for scalar fields. Two narrow implementation gaps remain, and
that's what this TODO is about.

### Implementation gaps to fix

1. **No try/catch around `parseEnvValue`.** Invalid number/boolean env
   values (e.g. `KAIZEN_FOO_TIMEOUT_MS=abc`) throw out of
   `applyEnvOverrides`, which is called inside `resolve()` with no guard,
   and unwind out through `register()`. A typo'd env var can crash
   plugin setup.
   - **Fix:** wrap `parseEnvValue` in a try/catch inside the
     `applyEnvOverrides` loop. On parse failure: log + skip the env
     override for that field, fall through to the next layer. Matches the
     "validation failure on boot logs and falls back to defaults"
     contract that file values already follow.

2. **No array/object parsing.** `parseEnvValue` has a
   `default: return raw` fallthrough — for any field whose `FieldSchema`
   is `array` or `object`, the env value flows through as a raw string,
   schema validation rejects it, the store falls back to defaults, and
   the user sees only a log line.
   - **Fix:** JSON-decode the raw string for array/object schemas.
     Document the format (`KAIZEN_FOO='["a","b"]'`). Re-validate the
     decoded value against the field schema before accepting it. On
     JSON parse failure, treat the same as gap 1 — log and skip.

### Policy drift to resolve (now done)

The 2026-05 migration also introduced doc drift on the back of the
"env is buggy" framing:

- `plugins/kaizen-config/README.md` had demoted `envVars` to "legacy".
  → reverted; env is first-class, deferred not legacy.
- `plugins/kaizen-config/CLAUDE.md` invariant called env resolution
  "legacy".
  → reverted to "first-class but currently deferred".
- `docs/config-migration/INTEGRATION.md` told plugin authors not to
  declare `envVars` because env-var resolution was "buggy".
  → corrected; the gaps are narrow, scalar fields work today, and the
  defer instruction stands only until the two fixes above land.

### Plugin env reads to restore once the gaps close

Pass 1 deleted these env reads from plugin code. After the gaps above
are fixed, they should be re-added as `envVars` mappings on the
respective `ConfigSpec` (not as direct `process.env` reads):

- `llm-system-prompt` → `KAIZEN_SYSTEM_PROMPT_GLOBAL` (`globalPath`),
  `KAIZEN_SYSTEM_PROMPT_PROJECT` (`projectPath`),
  `KAIZEN_SYSTEM_PROMPT_DISABLE` (`enabled`). CI/container users
  overriding the global prompt path is a real use case.
- `llm-skills` → `KAIZEN_LLM_SKILLS_PATH` (`userRoot`),
  `KAIZEN_LLM_SKILLS_RESCAN_MS` (`rescanIntervalMs`).
- `llm-environment` → `KAIZEN_ENVIRONMENT_DISABLE` (`enabled`). This is
  a kill switch — borderline whether it's "config" or "debug
  instrumentation". My take: leave it as a config field with an env
  binding, since users genuinely want to flip this without editing a
  file.

API keys (`OPENAI_API_KEY`, `TAVILY_API_KEY`) should **not** come back
as `envVars` on the secret field — they should use the `env:` scheme
on `secrets:registry` (`apiKey: { "$ref": "env:OPENAI_API_KEY" }` in
`config.json`) so the no-plaintext-on-disk invariant holds. The
`env:` resolver already exists in kaizen-config and is the right
abstraction for credentials.

The plan files under `docs/config-migration/PLAN-*.md` list every
deleted env var for reference.

### Non-issues (do not "fix")

These are things the original TODO draft listed that turned out to be
intentional design, not bugs:

- Env values only re-evaluated on file-change recompute, not on env
  change mid-session. `process.env` doesn't change at runtime — boot-time
  read is correct.
- No slash command to show where each value came from. Useful UX, not
  a bug. Lower priority than the two gaps above.
