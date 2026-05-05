# llm-memory

File-backed persistent memory for the openai-compatible harness. Reads and writes Claude-Code-compatible markdown memories under `<project>/.kaizen/memory/` and `~/.kaizen/memory/`, injects the merged `MEMORY.md` blocks plus an entry catalog into every LLM request, and exposes a service plus two tools for reading and writing memory.

## What it does

- Maintains two memory layers on disk:
  - **Project:** `<cwd>/.kaizen/memory/` (created lazily; can be disabled via config).
  - **Global:** `~/.kaizen/memory/` (always on).
- On every LLM call, appends a fenced `<system-reminder>` block to `request.systemPrompt` containing:
  - The user-authored prelude of each layer's `MEMORY.md`.
  - A catalog of available entries (`scope:name — description`) loadable on demand via tool.
  - Truncates per-layer index bodies and the catalog (oldest-first) to a configurable byte cap.
  - Skips injection entirely when neither layer has any content.
- Stores entries as markdown files with YAML frontmatter (`name`, `description`, `type`, `created`, `updated`); format mirrors Claude Code's auto-memory layout so existing memories are portable.
- Auto-maintains the catalog block in each layer's `MEMORY.md` between `<!-- llm-memory:catalog:start -->` / `<!-- llm-memory:catalog:end -->` markers; user content above the markers is preserved verbatim.
- Atomic writes (temp file + `rename`) for every entry and for `MEMORY.md` regeneration. Sweeps stale `.tmp.*` files older than `staleTempMs` at startup.
- Optional auto-extraction (off by default): on `turn:end`, if the last user message contains a trigger phrase, issues a side conversation gated to the `memory_save` tool to draft a memory.

## Wiring

### Provides

**Service** — `memory:store`

```typescript
type MemoryType = "user" | "feedback" | "project" | "reference";
type MemoryScope = "project" | "global";

interface MemoryEntry {
  name: string;
  description: string;
  type: MemoryType;
  scope: MemoryScope;
  body: string;
  created?: string;     // ISO-8601, set on first put
  updated?: string;     // ISO-8601, refreshed on every put
}

interface MemoryStoreService {
  get(name: string, opts?: { scope?: MemoryScope }): Promise<MemoryEntry | null>;
  list(filter?: { type?: MemoryType; scope?: MemoryScope }): Promise<MemoryEntry[]>;
  search(query: string, opts?: { scope?: MemoryScope; limit?: number }): Promise<MemoryEntry[]>;
  put(entry: MemoryEntry): Promise<void>;
  remove(name: string, scope: MemoryScope): Promise<void>;
  readIndex(scope: MemoryScope): Promise<string>;
}
```

Semantics:
- `get()` with no `scope` checks project then global (project shadows global on collision).
- `put()` is atomic and re-renders the catalog block in `MEMORY.md` afterwards. `created` is preserved across overwrites; `updated` is refreshed every write.
- `put()` rejects names that fail the `[a-z0-9_-]{1,64}` validator and rejects writes to a disabled scope (`projectDir=null`).
- `remove()` is a no-op for missing entries; otherwise re-renders the catalog.
- `readIndex()` returns raw `MEMORY.md` content (`""` when missing or scope disabled).

**Tools** (registered into `tools:registry` when that service is present):

- `memory_recall({ query?, names?, type? })` — tags `["memory", "read"]`. With `names`, exact-loads each (project shadows global); otherwise fuzzy-matches `query` against `name` (prefix) + `description` (substring), capped at 5 results. Filters by `type` if provided. Entries whose `type` is in `denyTypes` are excluded.
- `memory_save({ name, description, content, type, scope? })` — tags `["memory", "write"]`. Defaults `scope` to `global`. Refuses to overwrite an existing entry unless `name` ends with `!` (e.g. `bun_git_dep_semver!`); on refusal returns a structured `{ ok: false, error }` instructing the caller to choose a new name. On success returns `{ ok: true, path: "<scope>:<name>" }`.

If `tools:registry` is absent, the service still works; the tools are simply not registered.

### Consumes

- **Event** — `llm:before-call` (mutable). Mutates `payload.request.systemPrompt` in place, appending the memory block (separated from existing content by a single blank line). Skipped when both layers are empty.
- **Event** — `turn:end` (only when `autoExtract: true`). Reads `{ reason, lastUserMessage, turnId }`; runs the trigger heuristic and, on hit, issues the side conversation.
- **Service** — `tools:registry` (optional). When present, registers `memory_recall` and `memory_save`.
- **Service** — `driver:run-conversation` (optional, only when `autoExtract: true`). Used to issue a tool-gated side conversation for extraction; missing service logs and skips.
- **Vocabulary** — `llm-events:vocabulary` (event payload types).

The plugin emits no events of its own. Tool invocations flow through `tools:registry` (which emits its own `tool:before-execute` / `tool:result`).

## Configuration

Settings file (JSON):

- Default path: `~/.kaizen/plugins/llm-memory/config.json`
- Override path: `KAIZEN_LLM_MEMORY_CONFIG=/abs/path/to/config.json`
- Missing file → defaults; malformed JSON throws at setup.

| Key | Default | Notes |
|-----|---------|-------|
| `globalDir` | `~/.kaizen/memory` | Override (e.g. point at a Claude path for a shared store). `~/` is expanded. |
| `projectDir` | `<cwd>/.kaizen/memory` | Set to `null` to disable the project layer entirely. `~/` is expanded. |
| `injectionByteCap` | `2048` | Per-layer cap for the index body and overall cap for the catalog list. Truncates oldest-first; appends `... [truncated]`. |
| `autoExtract` | `false` | Enable opt-in side-call extraction on `turn:end`. |
| `extractTriggers` | `["from now on", "remember that", "always", "never", "i prefer", "my "]` | Phrases that gate extraction. Matched case-insensitively with a left word boundary. |
| `denyTypes` | `[]` | Entry `type`s to exclude from injection AND from `memory_recall` results. |
| `staleTempMs` | `60000` | Startup sweeper threshold for orphaned `.tmp.*` files. |

## File format

Every entry: a single markdown file `<name>.md` with YAML frontmatter.

```
---
name: bun_git_dep_semver
description: Bun #semver over git URLs unsupported — pin literal tag/SHA
type: reference
created: 2026-04-15T10:23:00Z
updated: 2026-04-30T08:11:00Z
---

# Body

Long-form markdown content.
```

`MEMORY.md` per layer:

```
# User Profile

Free-form user-authored content above the marker is preserved byte-for-byte.

<!-- llm-memory:catalog:start -->
- [bun_git_dep_semver](bun_git_dep_semver.md) — Bun #semver over git URLs unsupported
- [vault_namespace](vault_namespace.md) — Vault namespace is "admin"
<!-- llm-memory:catalog:end -->
```

If the markers are missing on first plugin write, they are appended at the end; existing content is untouched.

## Privacy

- All writes land as plain text under the configured directories. There is no encryption at rest.
- The plugin makes no outbound calls. The injected block is only sent as part of the normal `llm:complete` request to the configured provider.
- Add `.kaizen/memory/` to your project `.gitignore` if the project tree is committed.
- `autoExtract: true` will write user-message snippets after a heuristic match. Review entries under `~/.kaizen/memory/` periodically and remove anything unintended.

## Permissions

`tier: unscoped` — reads/writes user-config directories (`~/.kaizen/`, `<cwd>/.kaizen/`). No network, no process spawn.
