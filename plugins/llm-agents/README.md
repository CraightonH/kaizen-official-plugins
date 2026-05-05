# llm-agents

Subagent dispatch and file-backed agent registry. Discovers markdown agent manifests on disk, exposes them as a registry, and registers a `dispatch_agent` tool that recursively runs a fresh conversation with the agent's system prompt and tool filter.

## What it does

- Discovers agent files at startup from two well-known directories:
  - **User scope:** `~/.kaizen/agents/*.md`
  - **Project scope:** `<cwd>/.kaizen/agents/*.md` (project shadows user on name collision)
- Parses each file's YAML frontmatter (`name`, `description`, optional `tools`, `tags`, `model`); the body is the agent's system prompt verbatim.
- Skips files that are malformed, oversized (> 64 KiB cap), or hit a symlink cycle, surfacing each as a `session:error`. The rest of the registry continues loading.
- Discovery runs in a microtask so plugin setup does not block on file I/O. While it's still running, `dispatch_agent` returns the tool error `Agent registry still loading; retry`.
- Programmatic registration is supported but restricted to names prefixed `runtime:` to avoid collisions with file-loaded agents.
- On every top-level (`trigger === "user"`) turn's first LLM call, appends an `## Available agents (use dispatch_agent to invoke)` section to the outgoing system prompt — one bullet per agent, descriptions trimmed to ~200 chars. Nested agent turns are not injected.
- The `dispatch_agent` tool walks the parent turn chain to compute depth, enforces a configurable max depth, builds a `RunConversationInput` from the manifest, and recurses into the driver. The sub-agent's tool view is the manifest filter merged with always-on tools (`dispatch_agent` plus `load_skill` when `skills:registry` is present). Cancellation propagates via the parent's `AbortSignal`. All failure modes return as tool errors, not crashes.
- Emits `status:item-update { key: "agents.active" }` while a dispatch is in flight and clears it on completion.

## Wiring

### Provides

**Service** — `agents:registry`

```typescript
interface AgentManifest {
  name: string;
  description: string;
  systemPrompt: string;
  toolFilter?: { names?: string[]; tags?: string[] };
}

interface AgentsRegistryService {
  list(): AgentManifest[];
  register(manifest: AgentManifest): () => void; // returns unregister
}
```

Semantics:
- `list()` returns the public view; internal fields (`sourcePath`, `scope`, `modelOverride`) are stripped.
- `register()` requires `name` to start with `runtime:`. Throws on collision. The returned function unregisters.
- File-loaded agents may have a `model` override applied at dispatch time but it is not part of the public manifest shape.

**Tool** — registered into `tools:registry` as `dispatch_agent` with tags `["agents", "core"]`. Parameters: `agent_name` (string), `prompt` (string).

### Consumes

- **Service** — `tools:registry` (required). Used to register `dispatch_agent`. If absent, dispatch is disabled and a `session:error` is emitted.
- **Service** — `driver:run-conversation` (required). The dispatch handler calls `runConversation()` with the manifest's system prompt, the user prompt as the only message, the merged tool filter, the optional model override, and `parentTurnId` set to the current turn id. If absent, dispatch is disabled and a `session:error` is emitted.
- **Service** — `skills:registry` (optional). When present, sub-agents additionally see `load_skill` regardless of their declared filter.
- **VOCAB** — `llm-events:vocabulary`. The plugin is a consumer of the shared event vocabulary; it does not define events.

### Events consumed

- `turn:start` — `{ turnId, trigger, parentTurnId? }` — feeds the turn tracker used for depth computation and for distinguishing top-level from agent turns.
- `turn:end` — `{ turnId }` — drops the tracker record and clears the per-turn injection guard.
- `prompt:system` — contributes a section with id `"llm-agents:available"`, priority `150`, and title `"Available agents (use dispatch_agent to invoke)"`. The render function returns one bullet per agent (descriptions trimmed to ~200 chars), or `""` when the registry is empty (causing the registry to drop the section). Generation is bumped on every registry mutation so callers re-render when agents are added or removed. The section is only rendered for top-level turns (`trigger === "user"`); nested agent turns are excluded.

### Events emitted

- `session:error` — discovery failures, missing required services, malformed config.
- `status:item-update` / `status:item-clear` — `{ key: "agents.active", value: <agent-name> }` around each dispatch.

## Configuration

Config file (JSON). Defaults shown.

```jsonc
{
  "maxDepth": 3,            // integer >= 1; cap on dispatch chain length
  "userDir":  "~/.kaizen/agents",
  "projectDir": ".kaizen/agents"
}
```

Resolution:
- Default path: `~/.kaizen/plugins/llm-agents/config.json`. Missing file → defaults.
- `KAIZEN_LLM_AGENTS_CONFIG` overrides the path. Missing override file → warning + defaults.
- Malformed JSON or invalid `maxDepth` → throws at setup.
- `userDir` / `projectDir` accept `~` and relative paths (resolved against `cwd`).

## Permissions

`tier: unscoped` — the plugin recursively invokes the driver, which can in turn invoke any registered tool. Treat as trusted infrastructure.
