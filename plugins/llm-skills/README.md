# llm-skills

Owns skill discovery and on-demand loading. Scans markdown files with YAML frontmatter from disk, exposes them as a registry, advertises them in the system prompt at turn start, and provides a synthetic `load_skill` tool the LLM can call to pull a body into context.

## What it does

- Scans two roots for `<name>/SKILL.md` files (CC-style directory-per-skill layout):
  - **Project:** `<cwd>/.kaizen/skills/<name>/SKILL.md`
  - **User:** `~/.kaizen/skills/<name>/SKILL.md`
  - The directory name (`<name>`) is the registered skill name. Flat, single segment.
  - Sibling files in the skill directory (`references/`, `scripts/`, etc.) are left alone by the scanner — the LLM accesses them via filesystem tools using the manifest's `baseDir`.
  - Frontmatter required: `name`, `description`; optional: `tokens`.
- Accepts programmatic skill registrations from other plugins (lowest priority).
- Conflict precedence (highest first): project → user → programmatic. Masked entries are dropped with a warning.
- Path-derived name always wins over a mismatched frontmatter `name` (with a warning).
- Caches token counts at registration; default heuristic is `Math.ceil(body.length / 4)`. Frontmatter `tokens:` overrides the heuristic.
- Initial scan at setup; subsequent scans are throttled and run on `turn:start` (default interval 30 s, configurable).
- Registers a `prompt:registry` section (id `llm-skills:available`, priority 160, title "Available skills") listing one bullet per skill with `~N tokens` and the description. Empty registry → section is dropped by the `prompt:registry` registry.
- Registers `load_skill` into `tools:registry`. Handler returns `{ name, tokens, body }` so the dispatch layer hands the body back as a tool message on the next turn.
- Bad frontmatter / unreadable files are skipped non-fatally; a `harness:error` is emitted so they surface in the UI.

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

**Tool** — `new_skill` (registered into `tools:registry` if available)

```jsonc
{
  "name": "new_skill",
  "parameters": {
    "type": "object",
    "properties": {
      "name":        { "type": "string" },
      "description": { "type": "string" },
      "body":        { "type": "string" },
      "scope":       { "type": "string", "enum": ["project", "user"] }
    },
    "required": ["name", "description", "body", "scope"],
    "additionalProperties": false
  },
  "tags": ["skills", "synthetic", "mutating"]
}
```

Creates a new skill at `<projectRoot|userRoot>/<name>/SKILL.md`. Validates name shape (`[a-z0-9][a-z0-9_-]*`, ≤64 chars), description (single-line, ≤200 chars, non-empty), and body (non-empty). Refuses on collision in the target scope (`lstat` — does not follow symlinks). After the write, triggers an immediate `rescan()` so the new skill is visible in the next turn's system prompt and immediately callable via `load_skill`. Returns `{ name, path, scope, tokens }`.

Routes through `llm-tool-approval` like any other mutating tool — the default `llm-skills:*` allow rule does not match the bare name `new_skill`, so the gate prompts by default. "Approve Always" persists the rule to the project's approval config.

### Consumes

- **Service** — `tools:registry` (declared in `services.consumes` so kaizen's topo-sort orders this plugin after the registry's provider when one exists). Functionally optional at runtime: if the service is absent, `load_skill` is not registered and the plugin logs a warning; the `prompt:registry` section still appears but the LLM cannot pull bodies.
- **Service** — `prompt:registry` (required; declared in `services.consumes`). Section id `llm-skills:available`, priority 160, title "Available skills". Registered at setup; generation bumped on rescan-changed and on programmatic register/unregister. If absent, a `harness:error` is emitted and the section is skipped.
- **Event** — `turn:start`. Drives throttled rescans.

### Events emitted

- `skill:available-changed` — `{ count: number }`. Emitted once after the initial scan, then after any rescan whose visible-key set differs from the previous one.
- `skill:loaded` — `{ name, tokens }`. Emitted from the `load_skill` handler after the body is resolved.
- `harness:error` — `{ message: string }`. Emitted for non-fatal scan failures (bad frontmatter, duplicate name within a layer).

Events are declared by the `llm-events` VOCAB; this plugin emits them but does not define them.

## Configuration

Configuration is routed through `kaizen-config`'s `config:store` service.
Edit values through the `/config` slash commands or directly in
`~/.kaizen/harnesses/<key>/config.json` under `plugins.llm-skills`.

| Field | Default | Effect |
|-------|---------|--------|
| `userRoot` | `~/.kaizen/skills` | User-scope skills root. A leading `~/` is expanded to `$HOME`. |
| `rescanIntervalMs` | `30000` | Throttle interval (ms) for `turn:start`-driven rescans. Values ≤ 0 fall back to the default at runtime. |

The project root is always `<ctx.cwd>/.kaizen/skills` and is not overridable
(intentional — see `CLAUDE.md`).

## Permissions

`tier: unscoped` — reads and writes files under `~/.kaizen/skills/` and `<project>/.kaizen/skills/` (writes only via the `new_skill` tool, which routes through `llm-tool-approval`). No process execution, no network.
