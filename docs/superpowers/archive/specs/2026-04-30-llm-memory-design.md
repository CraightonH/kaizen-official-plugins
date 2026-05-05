# `llm-memory` — Persistent Memory Plugin (Spec 9)

> **Note:** Config paths use the `~/.kaizen/<subdir>/` convention. See Spec 0 for rationale.

**Status:** draft
**Date:** 2026-04-30
**Tier:** 3 (C milestone)
**Depends on:** Spec 0 (foundation), `llm-events`, `llm-tools-registry` (Spec 3), `llm-driver` (Spec 2)
**Scope:** A single plugin, `llm-memory`, that injects relevant persistent memory into every LLM call and provides tools/services for reading and writing memory. File-based storage, Claude-Code-compatible on-disk format, project + global merge, atomic writes.

## Goal

Give the openai-compatible harness durable, cross-session memory that:

1. Auto-injects a compact index into every LLM request so the assistant has continuous awareness of user preferences, project context, and recurring corrections.
2. Lets the LLM pull richer memory entries on demand via a tool, instead of bloating every prompt.
3. Lets other plugins (slash commands like `/remember`, agents, skills) write memory entries through a documented service.
4. Stores memories in a format compatible with Claude Code's auto-memory directory layout, so a user's existing memories are portable to and from this harness.

## Non-goals

- Vector embeddings, semantic search, or any RAG infrastructure. Memory matching is filename + description string match in v0.
- Cross-machine sync. The on-disk directory is the source of truth; sync is the user's responsibility (git, dotfiles, syncthing, etc.).
- Automatic durable-fact extraction enabled by default. v0 ships extraction OFF; Section "Auto-extraction" explains the opt-in path.
- Encryption at rest. Memory files are plain markdown.

## Architectural overview

`llm-memory` is a passive subscriber + active service provider. It owns no UI and runs no background work outside event handlers.

- **Read path:** subscribes to `llm:before-call` (mutable). On each call, reads the current `MEMORY.md` index from project + global directories, merges them, and appends the rendered block to `request.systemPrompt`. Adds a one-line catalog of available entry filenames + descriptions.
- **Write path:** exposes a `memory:store` service. Other plugins call it to persist a new entry. All writes go through the same atomic-write helper and update the `MEMORY.md` index.
- **Tool path:** registers two tools into `tools:registry`:
  - `memory_recall({ query? })` — load matching entries' bodies on demand.
  - `memory_save({ name, content, type })` — let the LLM itself persist a memory.
- **Optional extraction path (off by default):** subscribes to `turn:end`. If enabled, runs a heuristic over the last user message; if the heuristic flags it, issues a side `driver:run-conversation` (with a tiny tool filter) asking the model to draft a memory, then writes it.

The plugin does NOT subscribe to streaming events (`llm:token`, etc.). All work happens at well-defined boundaries.

## Storage layout

### Default directories

| Layer | Path | When written | When injected |
|---|---|---|---|
| Project | `<project>/.kaizen/memory/` | When the harness is invoked inside a project root that has (or opts into) this dir | First |
| Global | `~/.kaizen/memory/` | Always | After project |

`<project>` is the harness's CWD at startup. If `<project>/.kaizen/memory/` does not exist, project-layer reads return empty and project-layer writes create the directory on first use (only when the user has opted into project memory; see Configuration).

### Why this path (and not Claude Code's path)

Claude Code's auto-memory lives at `~/.claude/projects/<slug>/memory/MEMORY.md`. The user already has memories there. We deliberately do NOT write into `~/.claude/...` by default — that is Claude Code's territory and writes from another harness could surprise the user.

Instead, we mirror the *file format* exactly so memories are portable:

- A user can `cp -r ~/.claude/projects/<slug>/memory/* ~/.kaizen/memory/` and everything works.
- A user who wants a single shared store can configure `globalDir` to point at a Claude path; both harnesses then read/write the same files. Document this trade-off in the README.

### File format (Claude-Code-compatible)

Every memory is a single markdown file with YAML frontmatter:

```
---
name: bun_git_dep_semver
description: Bun #semver over git URLs unsupported — pin literal tag/SHA
type: reference
created: 2026-04-15T10:23:00Z
updated: 2026-04-30T08:11:00Z
---

# Body

Long-form markdown content. Free-form. Loaded on demand by `memory_recall`.
```

**Required frontmatter:**

| Field | Type | Notes |
|---|---|---|
| `name` | string | filename stem; `[a-z0-9_-]+`, max 64 chars |
| `description` | string | one-line summary, max 200 chars; shown in the catalog and used for query matching |
| `type` | enum | `user` \| `feedback` \| `project` \| `reference` |

**Optional frontmatter:** `created`, `updated` (ISO-8601). Both written automatically; absence is tolerated for hand-edited files.

### `MEMORY.md` index

Every memory directory contains a `MEMORY.md` that is the *injected* artifact. It is a plain markdown file authored by the user OR auto-maintained by the plugin (configurable, see below). Format:

```
# User Profile / Project Notes / etc.

Free-form markdown. Whatever the user wants pinned into every turn.

- [bun_git_dep_semver](bun_git_dep_semver.md) — Bun #semver over git URLs unsupported
- [vault_namespace](vault_namespace.md) — Vault namespace is "admin"
```

The bullet list at the bottom is the canonical "catalog" of entries. The plugin re-renders it on every write so it stays in sync with on-disk files. Anything above the catalog marker is preserved verbatim.

A catalog marker comment delineates user-owned content from plugin-owned content:

```
<!-- llm-memory:catalog:start -->
- [name](name.md) — description
<!-- llm-memory:catalog:end -->
```

If the markers are absent (e.g. user-authored MEMORY.md from before this plugin existed), the plugin appends them at the bottom on first write.

### Size budget

The injected `MEMORY.md` is hard-capped at **2 KB** per layer (project + global = 4 KB max). On `llm:before-call`, if the rendered MEMORY.md exceeds the cap, the plugin truncates the catalog (oldest entries first) and emits a `status:item-update` warning. Body content above the catalog is never truncated; if user-authored content alone exceeds the cap, the plugin logs a warning and injects the truncated version with a `... [truncated]` marker.

## Injection contract

On `llm:before-call` the plugin mutates `request.systemPrompt` in place. It appends (never replaces) using a clearly fenced block:

```
<system-reminder>
# Persistent memory

The following memory has been loaded automatically. Treat it as authoritative
context about the user, their projects, and prior feedback.

## Project memory (<project-path>)

<contents of <project>/.kaizen/memory/MEMORY.md>

## Global memory (~/.kaizen/memory/)

<contents of ~/.kaizen/memory/MEMORY.md>

## Available memory entries (use the `memory_recall` tool to load any of these)

- project:bun_git_dep_semver — Bun #semver over git URLs unsupported
- global:vault_namespace — Vault namespace is "admin"
</system-reminder>
```

**Ordering rules:**

- Project block first, global block second. Project memory wins implicitly because the model sees it first.
- If `request.systemPrompt` is already non-empty, the memory block is appended after a single blank line.
- If neither layer has any content (no `MEMORY.md` and no entries), the plugin makes no mutation. No empty headers.

The block is NOT a separate `system` message in `messages[]`. Keeping it in `systemPrompt` means dispatch-strategy `systemPromptAppend` (Spec 0) and memory injection compose cleanly: dispatch's tool surface comes after memory.

## Service interfaces

### `memory:store` (`llm-memory`)

```ts
export type MemoryType = "user" | "feedback" | "project" | "reference";
export type MemoryScope = "project" | "global";

export interface MemoryEntry {
  name: string;
  description: string;
  type: MemoryType;
  scope: MemoryScope;
  body: string;
  created?: string;     // ISO-8601, set automatically on create
  updated?: string;     // ISO-8601, refreshed on every write
}

export interface MemoryStoreService {
  /** Read one entry by name. Project layer wins on collision. */
  get(name: string, opts?: { scope?: MemoryScope }): Promise<MemoryEntry | null>;

  /** List entries' frontmatter (no bodies). */
  list(filter?: { type?: MemoryType; scope?: MemoryScope }): Promise<MemoryEntry[]>;

  /** Match by description substring or name prefix; bodies included. */
  search(query: string, opts?: { scope?: MemoryScope; limit?: number }): Promise<MemoryEntry[]>;

  /** Write or overwrite. Atomic. Re-renders the catalog in MEMORY.md. */
  put(entry: MemoryEntry): Promise<void>;

  /** Remove an entry and update the catalog. No-op if missing. */
  remove(name: string, scope: MemoryScope): Promise<void>;

  /** Read raw MEMORY.md for a layer (used by injection; exposed for `/memory` slash). */
  readIndex(scope: MemoryScope): Promise<string>;
}
```

Consumers: `llm-slash-commands` (e.g. `/remember`), `llm-agents`, future `llm-skills`-authored skills that want to persist learning.

## Tools registered into `tools:registry`

### `memory_recall`

```
Description: Load the full body of one or more saved memories.
Args: { query?: string; names?: string[]; type?: MemoryType }
Returns: { entries: { name, scope, type, description, body }[] }
```

Behavior:

- If `names` is given, exact-match load from any layer (project shadows global on collision).
- Otherwise, fuzzy-match `query` against `name` + `description` of every entry; return up to 5 results.
- If `type` is given, filter to that type.
- Tags: `["memory", "read"]`.

### `memory_save`

```
Description: Persist a new memory for future turns.
Args: { name: string; description: string; content: string; type: MemoryType; scope?: MemoryScope }
Returns: { ok: true; path: string }
```

Behavior:

- Defaults `scope` to `global`. The model must explicitly pass `"project"` to scope to project.
- Calls `memory:store.put`. Emits `status:item-update` confirming the save.
- Tags: `["memory", "write"]`.
- Refuses to overwrite existing entries unless `name` ends with `!` (a deliberate, awkward gesture). Otherwise returns an error message instructing the LLM to choose a new name or call `memory_save` again with the suffix.

## Concurrency and durability

Multiple plugins (and tool calls) can write memory simultaneously. Strategy:

1. **Atomic writes.** Every `put` writes to `<dir>/<name>.md.tmp.<pid>.<rand>`, fsyncs, then `rename()`s onto `<name>.md`. POSIX rename is atomic within a directory. No partial-content reads possible.
2. **MEMORY.md regeneration is also atomic.** Same temp-write-then-rename. The regenerator reads all entry frontmatter, sorts by `name`, rewrites the catalog block between the markers.
3. **No file locks.** A racing writer simply overwrites; the catalog is rebuilt from the *current set of files on disk* on every write, so the index always reflects ground truth even after concurrent races.
4. **Read consistency.** Injection reads `MEMORY.md` once per `llm:before-call`. A write that lands mid-read is fine — the read sees a consistent prior version (atomic rename guarantees).
5. **Crash safety.** A crashed writer leaves a `.tmp.*` file. The plugin's startup hook sweeps `.tmp.*` files older than 60 s. Documented in the README.

No SQLite, no lockfiles, no daemon. Plain files + rename are sufficient for human-scale write volumes (`<10/min` typical).

## Auto-extraction (opt-in, off by default)

Configurable via plugin settings (`autoExtract: false` default). When enabled:

1. Subscribe to `turn:end` with `reason === "complete"`.
2. Run a cheap heuristic on the *last user message in the turn*: contains any of the trigger phrases ("from now on", "remember that", "always", "never", "I prefer", "my <X> is"). If no match, exit.
3. Issue a side `driver:run-conversation` with:
   - a minimal system prompt asking the model to decide whether the message contains a durable preference and, if so, draft a `MemoryEntry`.
   - `toolFilter: { names: ["memory_save"] }` so the only thing the model can do is save it.
   - `parentTurnId` set to the just-ended turn for telemetry.
4. The side call's transcript is NOT appended to the main conversation.

Risks documented in the README:

- Side calls cost tokens. Heuristic gating makes this rare but not free.
- The model may save things the user did not intend. The user can audit `~/.kaizen/memory/` and remove entries.
- Recommend `autoExtract: true` only after the user has reviewed the extraction prompt and is comfortable with the privacy implications (Section "Privacy").

## Privacy

Memory writes capture conversational content. Implications:

- Anything passed to `memory_save` (by the LLM) or `memory:store.put` (by another plugin) is persisted in plain text on disk under `~/.kaizen/memory/`.
- Auto-extraction can write user-message snippets even if the user did not explicitly ask to save them. This is why it ships off by default.
- The plugin emits a `status:item-update` on every write so the TUI can surface "memory saved: <name>" to the user. Users notice writes in real time.
- The README MUST recommend a `.gitignore` rule for `.kaizen/memory/` if the project directory is committed.

No memory content is sent anywhere except as part of the normal `llm:complete` request to the configured provider. The plugin never makes its own outbound calls.

## Configuration

Plugin settings (read via the standard plugin-settings file pattern):

| Key | Default | Notes |
|---|---|---|
| `globalDir` | `~/.kaizen/memory` | Override to point at a Claude-compatible directory |
| `projectDir` | `<cwd>/.kaizen/memory` | Override or set null to disable project layer |
| `injectionByteCap` | `2048` | Per-layer cap on injected MEMORY.md |
| `autoExtract` | `false` | Enable opt-in extraction described above |
| `extractTriggers` | (default list) | Override heuristic phrases |
| `denyTypes` | `[]` | If set, skip entries whose `type` is in the list (e.g. `["feedback"]`) |

## Permissions

`tier: "trusted"` — the plugin reads and writes user-config directories (`~/.kaizen/`, `<project>/.kaizen/`). Same tier as `claude-events`, `llm-events`, and other foundation plugins.

Specifically the plugin needs:

- Read/write filesystem under `globalDir` and `projectDir`.
- Read filesystem at `<project>/.kaizen/memory/MEMORY.md` and entries.
- No network. No process spawn. No env mutation.

## Test plan

Unit + integration tests, all driven from the plugin's own test harness (mock event bus + service registry, real tmpdir for filesystem):

1. **Injection format**
   - Empty memory dirs → no mutation to `request.systemPrompt`.
   - Project-only → block contains only project section + catalog.
   - Both layers → project section before global section, both catalogs concatenated with scope prefix.
   - Existing `request.systemPrompt` is preserved and a single blank line separates it from the appended block.
   - Byte cap exceeded → catalog truncated oldest-first, body content unchanged.

2. **File-based round-trip**
   - `put({ name, description, type, body, scope })` then `get(name)` returns identical content (frontmatter + body).
   - `created` set on first write; `updated` refreshed on every write; `created` preserved across overwrites.
   - Hand-authored file with no `created`/`updated` is read successfully.

3. **Type filtering**
   - `list({ type: "user" })` returns only `user` entries.
   - `denyTypes: ["feedback"]` excludes feedback entries from injection AND from `memory_recall` results.
   - `memory_recall({ type: "reference" })` filters correctly.

4. **Atomic writes**
   - Concurrent `put`s of *different* names complete without data loss; both files exist; catalog includes both.
   - Concurrent `put`s of the *same* name: last writer wins; no `.tmp.*` left behind after a brief settle.
   - Simulated crash mid-write (write to `.tmp.*`, never rename) → next read ignores the orphan; startup sweeper removes it after the staleness threshold.
   - `MEMORY.md` regeneration is atomic: forced read during regeneration sees either the old or new index, never a partial.

5. **Tool integration**
   - `memory_recall` with no args returns matches by description fuzzy-match.
   - `memory_recall({ names: ["x"] })` exact-loads one entry; missing names produce a structured error inside the tool result, not an exception.
   - `memory_save` happy path writes to disk and updates the catalog.
   - `memory_save` with an existing name (no `!` suffix) returns a refuse-with-instructions tool result.
   - Both tools emit `tool:before-execute` / `tool:result` via `tools:registry.invoke` (verified by spy).

6. **Catalog rendering**
   - User-authored content above the catalog markers is preserved byte-for-byte across writes.
   - Missing markers in a hand-authored MEMORY.md → markers appended on first plugin write; user content untouched.
   - Removing the last entry leaves an empty catalog block (markers retained).

7. **Service contract**
   - `memory:store.search("vault")` matches by both `name` and `description`.
   - `get` with `scope: "project"` does not fall through to global.
   - `get` with no `scope` returns project on collision.

8. **Auto-extraction (only when enabled)**
   - Heuristic miss → no side call issued (verified by `driver:run-conversation` spy).
   - Heuristic hit → side call issued with `toolFilter: { names: ["memory_save"] }` and the disabled-by-default flag flips behavior cleanly.

## Open questions

- Should the `memory_save` tool emit `conversation:system-message` to make memory writes visible in the transcript? Defer; current design keeps writes silent except for `status:item-update`.
- Multi-project workflows (`cd`-ing between projects mid-session) — should project memory hot-reload? v0 reads on every `llm:before-call`, so yes implicitly. Verify performance.
- `description` matching is naive substring match; will users want regex? Defer until a user asks.

## Acceptance criteria

- `llm-memory` plugin builds and passes its own tests.
- A C-tier harness with `llm-memory` registered injects a working memory block on every `llm:before-call`, verified end-to-end with a mock LLM.
- `memory:store` service is callable from another plugin (verified by an integration test that uses the slash-commands plugin to call `memory:store.put`).
- `memory_recall` and `memory_save` are listed by `tools:registry.list({ tags: ["memory"] })`.
- A pre-existing Claude-Code memory directory copied into `~/.kaizen/memory/` is read without modification (frontmatter, body, MEMORY.md catalog all parse).
- README documents: directory choice, opt-in for `autoExtract`, privacy implications, suggested `.gitignore` line for project memory.

## Changelog

(none yet)
