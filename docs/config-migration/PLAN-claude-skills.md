# Migration plan (pass 2): claude-skills

## Current state

- Plugin already registers with `config:store` and exposes one knob,
  `rescanIntervalMs`.
  - `plugins/claude-skills/index.ts:51-58` — `cfgSvc.register()` with inline
    schema and an `envVars` mapping.
  - `plugins/claude-skills/index.ts:59-63` — initial `get()` + `watch()` keeps
    `currentIntervalMs` live.
- Manifest declares both consumes correctly: `plugins/claude-skills/package.json`
  has no `services` block, but `index.ts:39` sets
  `services: { consumes: ["skills:registry", "config:store"] }`. Plugin name
  (`"claude-skills"`) matches `ConfigSpec.plugin` at `index.ts:36, 52`.
- `permissions: { tier: "unscoped" }` — no per-path fs entries to prune.
- No legacy per-plugin config-file reader exists.

## Issues found

### Missed knobs

- `plugins/claude-skills/index.ts:24-28` hardcodes the three scan roots:
  `<cwd>/.claude/skills`, `~/.claude/skills`, `~/.claude/plugins/cache`. These
  are CC conventions, so leaving them hardcoded is defensible — but exposing
  them as optional overrides (`projectSkillsDir`, `userSkillsDir`,
  `pluginCacheDir`, each defaulting to the current value) would let a user
  point the shim at a custom skills tree without forking the plugin.
  Recommended to add. Rationale: matches the canonical "tune any constant the
  user might plausibly want to change" guidance from `INTEGRATION.md` §"Why
  migrate".
- No other constants are user-facing knobs. `frontmatter.ts`, `hash.ts`,
  `registrar.ts` are pure and parameterless. `scan.ts` has no tunable
  thresholds.

### Pattern deviations

Reference: `plugins/llm-axioms/{index.ts,config.ts}` and
`docs/config-migration/INTEGRATION.md` §"The canonical plugin layout".

1. **No `config.ts` module.** Defaults + schema are inlined in `index.ts:8-12,
   54-57`. Canonical pattern is a separate pure `config.ts` exporting
   `DEFAULT_CONFIG` (frozen) and `CONFIG_SCHEMA: Record<keyof Config, FieldSchema>`.
2. **`DEFAULTS` not `Object.freeze`d.** `index.ts:12`. Canonical:
   `llm-axioms/config.ts:4` uses `Object.freeze({...}) as Config`.
3. **Schema is inline literal, not a `Record<keyof Config, FieldSchema>` constant.**
   `index.ts:54-56`. Canonical: `llm-axioms/config.ts:15-21`.
4. **`ClaudeSkillsConfig` interface lives in `index.ts:8-10`, not `public.d.ts`.**
   `public.d.ts` is currently `export {};`. Canonical placement is
   `public.d.ts` even for plugin-private config types (matches `llm-axioms/public.d.ts`).
5. **`envVars` declared on the spec.** `index.ts:57` —
   `envVars: { rescanIntervalMs: "KAIZEN_CLAUDE_SKILLS_RESCAN_MS" }`. Per
   `INTEGRATION.md` §"What this migration does NOT do", env-var support is
   being dropped; this declaration must be removed.
6. **Direct `process.env` read.** `index.ts:14-19` reads `HOME` via a
   `readEnv()` helper that consults `ctx.env` then `process.env`. The `HOME`
   read is unrelated to a config knob (it feeds `homedir()` fallback), but
   `INTEGRATION.md` §"Removing the legacy config code" says to delete direct
   `process.env` reads associated with the migration. `homedir()` alone is
   sufficient — the `ctx.env`/`process.env` HOME read should go.
7. **`register()` not wrapped in try/catch.** `index.ts:51-58`. Canonical:
   `llm-axioms/index.ts:45-57` wraps with try/catch and logs a fallback
   message; this guards against double-register (e.g. hot reload).
8. **No `DEFAULT_CONFIG` fallback path.** Both `skills:registry` and
   `config:store` are treated as hard `throw` deps (`index.ts:46, 49`). The
   plugin's `CLAUDE.md` explicitly documents this as intentional ("zero value
   without them"). Borderline — leaving it hard is defensible, but the
   canonical pattern in `INTEGRATION.md` is to fall back to `DEFAULT_CONFIG`
   when `config:store` is genuinely missing so plugin tests with a fake `ctx`
   keep working. Recommend: keep `skills:registry` hard, but soften
   `config:store` to log-and-fall-back-to-defaults like `llm-axioms`.
9. **Redundant `consumeService` calls.** `index.ts:42-43` call
   `ctx.consumeService(...)` for both services, then immediately `useService`
   them on the next lines. `llm-axioms` only uses `useService`. The
   `consumeService` calls duplicate the manifest `consumes` declaration and
   are not part of the canonical pattern.

### Doc drift

- `README.md:21-25` documents the env-var column
  (`KAIZEN_CLAUDE_SKILLS_RESCAN_MS`). After `envVars` removal, the table needs
  to drop the "Env" column.
- `CLAUDE.md` is accurate w.r.t. module map; no drift after the proposed
  changes other than the new `config.ts` entry to add.

## Proposed changes

Edits:

- Create `plugins/claude-skills/config.ts` exporting:
  - `DEFAULT_CONFIG: ClaudeSkillsConfig` wrapped in `Object.freeze(...) as ClaudeSkillsConfig`.
  - `CONFIG_SCHEMA: Record<keyof ClaudeSkillsConfig, FieldSchema>`.
- Move `ClaudeSkillsConfig` interface from `index.ts` to `public.d.ts`.
- In `index.ts`:
  - Import `DEFAULT_CONFIG`, `CONFIG_SCHEMA` from `./config.ts`.
  - Replace `cfgSvc.register` inline literals with the imported constants.
  - Wrap `register()` + initial `get()` in try/catch; on failure, log and
    keep `DEFAULT_CONFIG` values.
  - Soften `config:store` to topo-hint-optional with fallback to
    `DEFAULT_CONFIG` (keep `skills:registry` as hard).
  - Drop the redundant `ctx.consumeService(...)` calls on lines 42-43.
  - Remove the `readEnv()` helper and the `HOME` lookup; rely on `homedir()`.
- Update `README.md` refresh table to remove the "Env" column.
- Update `CLAUDE.md` module map to mention `config.ts`.

New fields (optional, recommended):

- `projectSkillsDir: string` (default `"<cwd>/.claude/skills"` — but defaults
  can't reference `cwd` at module load time; either resolve in `setup()` from
  a `""` sentinel meaning "use built-in", or store as a relative `".claude/skills"`
  and join with `cwd` in `resolveRoots`).
- `userSkillsDir: string` (default `"~/.claude/skills"`, `~` expansion at
  use-site).
- `pluginCacheDir: string` (default `"~/.claude/plugins/cache"`).

If skipping the path-knobs (defensible — CC convention), document the
omission in the plan's "Risks / open questions" so a future audit doesn't
re-flag it.

Deletions:

- `envVars: { rescanIntervalMs: "KAIZEN_CLAUDE_SKILLS_RESCAN_MS" }` at
  `index.ts:57`.
- `readEnv()` function and its `process.env` read (`index.ts:14-19`).
- The `KAIZEN_CLAUDE_SKILLS_RESCAN_MS` row/column from `README.md`.

## Risks / open questions

- Path knobs (project/user/plugin-cache roots) are arguably CC-specification,
  not user-config. If we expose them, "what does pointing them elsewhere
  mean" needs a one-liner in README. Recommend: ship path knobs but mark
  them advanced; default behavior unchanged.
- The current hard-throw on `config:store` is a deliberate choice in
  `CLAUDE.md`. Softening to fallback diverges from that note; the note needs
  a small revision ("hard except when running with a fake ctx — falls back to
  defaults").
- `watch()` is currently in use (live updates to `rescanIntervalMs`). Keep
  it; it's not dead weight here.

## Contract proposals

None. Existing `FieldSchema` types cover all proposed fields.
