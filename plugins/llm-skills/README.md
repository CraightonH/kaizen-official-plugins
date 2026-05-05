# llm-skills

Owns skill discovery and on-demand loading. Scans markdown files with YAML frontmatter from disk, exposes them as a registry, advertises them in the system prompt at turn start, and provides a synthetic `load_skill` tool the LLM can call to pull a body into context.

## What it does

- Scans two roots for `.md` files with frontmatter (`name`, `description`, optional `tokens`):
  - **Project:** `<cwd>/.kaizen/skills/`
  - **User:** `~/.kaizen/skills/`
  - Subdirectories namespace the skill: `python/poetry-deps.md` → `python/poetry-deps`.
- Accepts programmatic skill registrations from other plugins (lowest priority).
- Conflict precedence (highest first): project → user → programmatic. Masked entries are dropped with a warning.
- Path-derived name always wins over a mismatched frontmatter `name` (with a warning).
- Caches token counts at registration; default heuristic is `Math.ceil(body.length / 4)`. Frontmatter `tokens:` overrides the heuristic.
- Initial scan at setup; subsequent scans are throttled and run on `turn:start` (default interval 30 s, configurable).
- Registers a `prompt:system` section (id `llm-skills:available`, priority 160, title "Available skills") listing one bullet per skill with `~N tokens` and the description. Empty registry → section is dropped by the `prompt:system` registry.
- Registers `load_skill` into `tools:registry`. Handler returns `{ name, tokens, body }` so the dispatch layer hands the body back as a tool message on the next turn.
- Bad frontmatter / unreadable files are skipped non-fatally; a `session:error` is emitted so they surface in the UI.

## Wiring

### Provides

**Service** — `skills:registry`

```typescript
interface SkillManifest {
  name: string;
  description: string;
  tokens?: number;
}

interface SkillsRegistryService {
  list(): SkillManifest[];
  load(name: string): Promise<string>;
  register(manifest: SkillManifest, loader: () => Promise<string>): () => void;
  rescan(): Promise<{ changed: boolean; count: number }>;
}
```

Semantics:
- `list()` returns manifests sorted by name. Cheap; called on every `llm:before-call`.
- `load(name)` resolves the loader for the highest-priority entry under that name. Throws if unknown.
- `register()` adds a programmatic entry at the lowest precedence. Returns an unregister fn.
- `rescan()` re-walks the file roots, rebuilds the file-backed half of the registry (programmatic entries preserved), and reports whether the visible set changed plus the new count.

**Tool** — `load_skill` (registered into `tools:registry` if available)

```jsonc
{
  "name": "load_skill",
  "parameters": {
    "type": "object",
    "properties": { "name": { "type": "string" } },
    "required": ["name"],
    "additionalProperties": false
  },
  "tags": ["skills", "synthetic"]
}
```

Handler returns `{ name, tokens, body }`. Errors (missing/empty `name`, unknown skill) propagate so `tools:registry` surfaces them via `tool:error`.

### Consumes

- **Service** — `tools:registry` (optional, declared in `services.consumes` so topo-sort orders this plugin after the registry's provider when present). Without it, `load_skill` is not registered and the plugin logs a warning; the `prompt:system` section still appears but the LLM cannot pull bodies.
- **Service** — `prompt:system`. Section id `llm-skills:available`, priority 160, title "Available skills". Registered at setup; generation bumped on rescan-changed and on programmatic register/unregister.
- **Event** — `turn:start`. Drives throttled rescans.

### Events emitted

- `skill:available-changed` — `{ count: number }`. Emitted once after the initial scan, then after any rescan whose visible-key set differs from the previous one.
- `skill:loaded` — `{ name, tokens }`. Emitted from the `load_skill` handler after the body is resolved.
- `session:error` — `{ message: string }`. Emitted for non-fatal scan failures (bad frontmatter, duplicate name within a layer).

Events are declared by the `llm-events` VOCAB; this plugin emits them but does not define them.

## Configuration

Environment variables (read at setup time via `ctx.env` then `process.env`):

| Var | Effect |
|-----|--------|
| `KAIZEN_LLM_SKILLS_PATH` | Override user root. Colon-separated; v0 honors only the first segment. |
| `KAIZEN_LLM_SKILLS_RESCAN_MS` | Throttle interval for `turn:start` rescans. Default 30000. |
| `HOME` | Used to resolve the default user root (`$HOME/.kaizen/skills`). |

The project root is always `<ctx.cwd>/.kaizen/skills` and is not overridable.

## Permissions

`tier: unscoped` — reads files under `~/.kaizen/skills/` and `<project>/.kaizen/skills/`. No writes, no process execution, no network.
