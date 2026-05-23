# claude-skills

Shim Claude Code's on-disk skills into the local harness's `skills:registry`.

## What it does

Scans the three CC skill discovery roots and registers each `SKILL.md` programmatically with `skills:registry`:

- Project: `<cwd>/.claude/skills/<name>/SKILL.md` → registered as `<name>`
- User: `~/.claude/skills/<name>/SKILL.md` → registered as `<name>`
- Plugin cache: `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/skills/<name>/SKILL.md` → registered as `<plugin>:<name>` (lex-highest version wins per plugin)

Cross-layer precedence: project > user > plugin-cache.

Each registered manifest carries `baseDir` (absolute path to the skill's directory). `llm-skills`'s `load_skill` handler uses this to prepend `Base directory for this skill: <baseDir>` to the returned body, matching CC's own load behavior so the LLM can resolve relative references like `references/foo.md`.

## Refresh

Throttled rescan on `turn:start`. Interval is configurable via `config:store`:

| Key | Default | Env | Where |
|---|---|---|---|
| `rescanIntervalMs` | 30000 | `KAIZEN_CLAUDE_SKILLS_RESCAN_MS` | `/config:set claude-skills rescanIntervalMs=<ms>` |

Live updates from `config:store` are honored on the next rescan.

## Wiring

### Consumes (both hard)

- `skills:registry` — no value without it; declared in `services.consumes` + `consumeService` + `useService`.
- `config:store` — same.

### Provides

Nothing. This plugin is a pure consumer/shim.

## Permissions

`tier: unscoped` — reads under `~/.claude/` and `<cwd>/.claude/`. No writes, no process execution, no network.

## Limits

- No FS watching; rescans are poll-on-`turn:start`.
- Plugin-cache version dedup is lexicographic (`2.0.0` beats `1.10.0` — be aware if your version strings break semver-as-lex).
- Skill bodies are read verbatim from `SKILL.md`; sibling files (`references/`, `scripts/`) are not surfaced through this plugin. The LLM accesses them via existing filesystem tools, using `baseDir` to anchor relative paths.
