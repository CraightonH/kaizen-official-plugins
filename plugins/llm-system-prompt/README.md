# llm-system-prompt

Owns construction of the assistant's system prompt. Other plugins contribute named, prioritized sections; this plugin assembles them into the final string the LLM sees.

## What it does

- Maintains a registry of system-prompt sections, each with an `id`, `priority`, `render()`, and optional `title`.
- Assembles sections in priority order (low → high) on demand, with caching keyed on a generation counter.
- Owns the `identity` section (priority 10) sourced from two markdown files:
  - **Global:** `~/.kaizen/system-prompt.md`
  - **Project:** `<cwd>/.kaizen/system-prompt.md`
  - Both → concatenated with a `## Project context` header between them.
  - Neither → built-in fallback (date-stamped).
- Reloads identity files from disk on demand (no restart required).
- Exposes diagnostic slash commands for inspecting and toggling sections at runtime.

## Wiring

### Provides

**Service** — `prompt:registry`

```typescript
interface SystemPromptSection {
  id: string;
  priority: number;
  render(): string | Promise<string>;
  title?: string;
}

interface RegisteredSection {
  unregister(): void;
  bumpGeneration(): void;
}

interface SystemPromptService {
  register(section: SystemPromptSection): RegisteredSection;
  assemble(): Promise<string>;
  list(): ReadonlyArray<{ id: string; priority: number; title?: string }>;
  generation(): number;
}
```

Semantics:
- `register()` claims an `id`. Re-registering a live `id` throws — call `unregister()` first.
- `assemble()` returns the same string instance until `generation()` changes (cache).
- Sections that render an empty string are omitted from the output.
- A section's `render()` throwing is caught and surfaced as an inline `<!-- render error … -->` comment; it does not break assembly.
- Sections with a `title` are emitted as `## {title}\n{body}`.

### Consumes

**Service** — `events:vocabulary` (required). Owns the `PROMPT_REBUILT`
and `PROMPT_RELOAD` event names and defines them before this plugin emits.

**Service** — `slash:registry` (optional). When already provided at setup, the plugin registers four diagnostic slash commands:
- `/prompt:show [--stats]` — print the assembled prompt with section headers; `--stats` adds per-section char counts and the generation counter.
- `/prompt:reload` — re-read identity files from disk and bump generation.
- `/prompt:disable <id>` — render a section as empty without removing it.
- `/prompt:enable <id>` — undo `/prompt:disable`.

If `slash:registry` is absent or loaded later, the service still works; only the slash commands are skipped.

### Events emitted

- `prompt:rebuilt` — `{ generation: number }`. Emitted whenever the registry mutates (register, unregister, bumpGeneration, disable, enable, reload). Consumers can use this to invalidate their own caches; alternatively, they can poll `generation()` per call (the assembly cache is keyed on this).
- `prompt:reload` — `{}`. Emitted when `/prompt:reload` runs. Identity files have already been re-read by the time this fires.

Events are declared in the `llm-events` VOCAB (`PROMPT_REBUILT`, `PROMPT_RELOAD`); this plugin emits them but does not define them.

## Configuration

Configured via `config:store` (`~/.kaizen/harnesses/<key>/config.json`, section `"llm-system-prompt"`). Read once at setup; use `/prompt:reload` to re-read identity files from disk. Changes to config fields require a harness restart.

| Field | Default | Effect |
|-------|---------|--------|
| `enabled` | `true` | When `false`, identity section renders empty (kill switch). |
| `globalPath` | `"~/.kaizen/system-prompt.md"` | Global identity markdown path. Tilde-expanded. |
| `projectPath` | `"./.kaizen/system-prompt.md"` | Project identity markdown path. Relative paths resolve against the harness cwd. |
| `projectHeader` | `"## Project context"` | Heading between global and project bodies. Empty string drops the heading. |
| `fallbackPrefix` | `"You are a helpful assistant running locally via the kaizen local harness."` | Prefix sentence used in the built-in fallback when neither identity file exists. |

## Permissions

`tier: unscoped` — reads identity markdown from the user's home/project
directories or env-override paths. No writes, network, or process execution.
