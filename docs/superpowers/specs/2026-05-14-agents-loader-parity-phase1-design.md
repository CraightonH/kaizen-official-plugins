# Agents Loader Parity with Claude Code — Phase 1

**Status:** approved design, awaiting plan
**Scope:** `plugins/llm-agents` plus one additive contract change in `plugins/llm-contracts`. No driver, TUI, or session-manager changes.
**Companion:** see `docs/superpowers/specs/2026-05-14-agents-slash-command-design.md` for the `/agents:list` / `/agents:show` UX that this spec extends.

## Goal

Bring kaizen's `llm-agents` file format and discovery up to parity with the
most impactful subset of Claude Code's custom-agent feature surface. Three
additive changes:

1. **Recursive subdirectory discovery** — `~/.kaizen/agents/` and
   `.kaizen/agents/` are walked depth-first, not just at the top level. Agent
   identity stays driven by the `name` field; paths are irrelevant for
   identity.
2. **Parse-error visibility in `/agents:list`** — errors emitted during
   discovery (missing frontmatter, size cap, parse failure, symlink cycle,
   depth cap, duplicate name) are surfaced as a footer in the slash command's
   output, alongside the existing `harness:error` event emission.
3. **`disallowedTools` / `disallowedTags` denylist frontmatter fields** — a
   manifest can carve specific tools out of the parent's tool view in
   addition to the existing `tools` / `tags` allowlist.

## Non-goals (deferred to later phases)

- **Model aliases** (`sonnet` / `opus` / `haiku`). Anthropic-specific; doesn't
  map to the openai-compatible harness, which already accepts free-form model
  strings.
- **`maxTurns`**, **`permissionMode`**, **`effort`**, **`background`**,
  **`isolation: worktree`**. Each requires a contract change in `llm-driver`
  or `kaizen` core.
- **Per-agent `mcpServers`, `hooks`, `memory`, `skills` preload.** Each is its
  own contract design (per-agent MCP namespace, per-agent hook scope, agent
  memory persistence semantics, skill snapshot injection).
- **Invocation UX**: `@-mention` autocomplete in the TUI, session-wide
  `--agent` boot mode, `initialPrompt`. Touch other plugins.
- **`color` / display hints.** TUI concern; defer until the TUI theme surface
  needs it.

## Architecture

Phase 1 keeps the existing plugin shape:

- `llm-contracts` gains two optional fields on `AgentManifest.toolFilter` —
  purely additive, no provider has to change.
- `llm-agents` extends three pure modules (`frontmatter.ts`, `loader.ts`,
  `tool-filter.ts`), the registry handle (`registry.ts`), and the slash
  renderer (`slash.ts`). The plugin's pure-factory boundary is preserved —
  only `index.ts` continues to touch `ctx`.
- No new modules. The recursive walk lives inside `loader.ts` (approach A
  from brainstorm; `walker.ts` extraction rejected for ceremony cost vs. ~30
  net new lines).

### File map

- **Modify** `plugins/llm-contracts/contracts/agents-registry.ts` — extend
  `AgentManifest.toolFilter` to add `excludeTags?` and `excludeNames?`.
- **Modify** `plugins/llm-agents/frontmatter.ts` — parse `disallowedTools` and
  `disallowedTags` frontmatter keys; map onto `toolFilter.excludeNames` and
  `toolFilter.excludeTags`.
- **Modify** `plugins/llm-agents/loader.ts` — recursive depth-first walk with
  hidden-dir skip, directory symlink-cycle guard, depth cap 8, lex-sorted
  flat result.
- **Modify** `plugins/llm-agents/tool-filter.ts` — add denylist branch;
  `toolPasses(tool, filter)` evaluates allowlist AND `NOT denylist`.
- **Modify** `plugins/llm-agents/registry.ts` — `RegistryHandle` gains a
  `getErrors()` accessor backed by an errors slot updated through
  `setInner(next, errors, onChange?)`.
- **Modify** `plugins/llm-agents/index.ts` — after `loadFromDirs(...)`
  resolves, call `handle.setInner(newRegistry, result.errors, bumpSection)`.
  Continue emitting `harness:error` for each error (unchanged) so other
  plugins still observe.
- **Modify** `plugins/llm-agents/slash.ts` — `listHandler` appends an
  `**Errors loading agents (N):**` footer when `getErrors()` is non-empty,
  rendered below either the agent list or the `No agents registered.` line.
- **Modify** `plugins/llm-agents/CLAUDE.md` — module map updates for the
  loader/registry/tool-filter changes; new invariants for denylist semantics
  and recursive walk depth cap.

### Contract change

`plugins/llm-contracts/contracts/agents-registry.ts`:

```ts
export interface AgentManifest {
  name: string;
  description: string;
  systemPrompt: string;
  /** Restricts the tool view available to this agent's nested driver runs. */
  toolFilter?: {
    tags?: string[];
    names?: string[];
    excludeTags?: string[];     // NEW
    excludeNames?: string[];    // NEW
  };
}
```

Additive. Consumers that don't set the new fields behave identically.
`provideService` implementations for `agents:registry` need no code change.

## Components

### Frontmatter parsing

`disallowedTools` and `disallowedTags` parse with the same rules as
`tools` and `tags`:

- Flow-array syntax only (e.g. `disallowedTools: ["edit_file", "write_*"]`).
- Elements must be strings.
- Empty array accepted; behaves identically to absence.
- Malformed (non-array, non-string element) → existing `ParseResult.error`
  path with wording mirroring the allowlist case:
  `${path}: 'disallowedTools' must be an array of strings`.

The resulting `InternalAgentManifest.toolFilter` carries `excludeNames` /
`excludeTags`. Both halves coexist with `names` / `tags` from the same
manifest.

### Recursive loader walk

`loader.ts`'s top-level loop is replaced by an internal recursive
`walk(dir, depth)`:

- `readdir(dir)`; sort entries lexicographically.
- For each entry:
  - **Skip** if name starts with `.` (so `.git`, `.DS_Store`, `.tmp`, etc.
    don't get walked or loaded).
  - `stat`. On failure, push `${full}: stat failed: <msg>` and continue.
  - If a directory:
    - If `depth >= 8` (the cap), push `${full}: directory depth exceeds 8; skipped`
      and do not recurse.
    - Else if `isSymbolicLink()`: `realpath`; if real path already in
      `seenRealPaths`, push `${full}: symlink cycle detected; skipped` and
      do not recurse. Otherwise mark visited and recurse with `depth + 1`.
    - Else recurse with `depth + 1`.
  - If a regular file:
    - If it doesn't end in `.md`, skip silently.
    - Otherwise run the existing size-cap / symlink-cycle / parse pipeline
      unchanged. Push errors as before.

Output is the same flat `{ manifests, errors }` shape `loadFromDirs` already
returns. Per-scope dedupe (lex-first wins on `name` collision) operates on
the flattened list, so collisions across subdirectories are still resolved
deterministically — the agent whose full path sorts lex-first wins.

### Tool filter denylist

`tool-filter.ts`:

```ts
function matchesAllowlist(tool, filter): boolean
function matchesDenylist(tool, filter): boolean   // NEW
export function toolPasses(tool, filter): boolean // renamed from toolMatches
```

`toolPasses` returns `matchesAllowlist(tool, filter) && !matchesDenylist(tool, filter)`.

`matchesAllowlist` keeps current behavior: returns `true` when both
`filter.names` and `filter.tags` are absent or empty (no allowlist =
everything passes the allow gate).

`matchesDenylist` returns `true` iff any pattern in `filter.excludeNames`
glob-matches `tool.name`, or any string in `filter.excludeTags` matches a
member of `tool.tags`. Absent/empty denylist returns `false` (nothing
denied).

If a tool appears in both the allow and deny lists, `toolPasses` returns
`false` (denylist wins). This matches the intuitive "subtract from the
allowed set" semantic.

Renaming `toolMatches` → `toolPasses` is internal — the function isn't
exported as a public contract. Search-and-replace in `dispatch.ts` and tests.

### Always-on tool invariant

`dispatch.ts` merges `dispatch_agent` and (when `skills:registry` is present)
`load_skill` *after* `toolPasses` filters the parent tool list. The
post-filter merge means a manifest cannot deny away the always-on tools —
even an explicit `disallowedTools: ["dispatch_agent"]` is a no-op. This is
the existing invariant; the only change is to add an explicit regression
test for the denylist case.

### Registry handle errors slot

`registry.ts`:

```ts
export interface RegistryHandle {
  service: AgentsRegistryService;
  getInternal(name: string): InternalAgentManifest | undefined;
  getErrors(): LoadError[];                                       // NEW
  setInner(next: AgentsRegistry, errors: LoadError[], onChange?: () => void): void;
}

export interface LoadError { path: string; message: string }
```

Internal storage stays in module-private state. `getErrors()` returns a
defensive copy so callers can't mutate the registry's view. Initial handle
construction (called from `setup()` with an empty registry) passes `[]` for
errors.

`AgentsRegistryService` is not modified. Load errors stay an llm-agents
implementation detail; no other plugin needs them.

### `index.ts` wiring

After discovery completes:

```ts
handle.setInner(makeRegistry(result.manifests, bumpSection), result.errors, bumpSection);
```

`harness:error` event emission for each error continues exactly as today.
The footer in `/agents:list` is *in addition to* event emission, not a
replacement — other plugins (logs, status items) keep observing errors.

### Slash footer

`listHandler` reads `deps.registry.getErrors()` after building the agent
lines. If errors non-empty, append:

```
\n\n**Errors loading agents (N):**\n- <path>: <message>\n- ...
```

In the empty-registry branch, the footer follows `No agents registered.`
separated by one blank line. Empty-errors → no footer (existing tests
unchanged).

Errors render in source order (the order `loader.ts` returned them, which is
lex-by-path).

## Output examples

**Healthy load:**

```
- **`code-reviewer`** [user] — Reviews diffs.
- **`db-migrator`** [project] — Plans and applies schema migrations safely.
```

**Mixed (some load, some fail):**

```
- **`code-reviewer`** [user] — Reviews diffs.

**Errors loading agents (2):**
- /Users/u/.kaizen/agents/coder.md: missing YAML frontmatter (file must begin with '---')
- /Users/u/git/project/.kaizen/agents/old/reviewer.md: agent file exceeds 64 KiB cap (98304 bytes); skipped
```

**Empty registry, errors only:**

```
No agents registered.

**Errors loading agents (2):**
- /Users/u/git/project/.kaizen/agents/coder.md: missing YAML frontmatter (file must begin with '---')
- /Users/u/git/project/.kaizen/agents/reviewer.md: missing YAML frontmatter (file must begin with '---')
```

**Frontmatter using all the new fields:**

```markdown
---
name: code-reviewer
description: >-
  Use when the user wants a focused review of a diff or specific file.
tools: ["read_file", "list_files", "grep*"]
tags: ["read-only"]
disallowedTools: ["edit_file", "write_file"]
disallowedTags: ["destructive"]
model: gpt-4o-mini
---
You are a focused code reviewer. ...
```

Tool-filter worked example. Tool registry exposes `edit_file` with tags
`["fs", "destructive"]`:

- Agent with `tools: ["read_*"]`, no denylist → `edit_file` filtered (not in
  allowlist).
- Agent with `tools: ["edit_*"]`, `disallowedTools: ["edit_file"]` → filtered
  (denylist wins over allowlist).
- Agent with no allowlist, `disallowedTags: ["destructive"]` → filtered
  (denied by tag).
- Agent with no allowlist, no denylist → passes (existing behavior).

## Error handling

All failure modes are non-fatal — they push `{ path, message }` into
`result.errors` and emit `harness:error`, never throw out of discovery.

| Condition | Behavior |
|---|---|
| Subdir `readdir` fails (perm denied, ENOENT mid-walk) | `${dir}: failed to read dir: <msg>`; do not descend; continue siblings. |
| Stat fails on an entry | Existing per-file error (`stat failed`); continue. |
| Symlinked file → cycle | Existing behavior, unchanged. |
| Symlinked directory → cycle | New: `realpath` the dir; if already in `seenRealPaths`, `symlink cycle detected; skipped`; do not recurse. |
| Depth cap hit (8 levels) | `${dirPath}: directory depth exceeds 8; skipped`. Subtree walk stops; siblings continue. |
| `.md` exceeds 64 KiB | Existing behavior. |
| `disallowedTools` malformed (non-array or non-string element) | `${path}: 'disallowedTools' must be an array of strings`. |
| `disallowedTags` malformed (non-array or non-string element) | `${path}: 'disallowedTags' must be an array of strings`. |
| Both allow + deny list the same entry | No error. Deny wins. |
| Always-on tool name appears in `disallowedTools` | No error and no effect — always-on merge is post-filter. |
| Existing `tools`/`tags`/size/parse semantics | Unchanged. |

`/agents:list` footer is purely a render of `getErrors()`. During the
discovery microtask window (before `setInner` runs), `getErrors()` returns
`[]` and the footer is silent.

## Testing

`bun:test`, hand-rolled fakes, matches existing plugin style.

**`loader.test.ts`** (extend):

- Recursive walk loads agents in nested subdirs (`a/b/foo.md`,
  `a/c/bar.md`); both register; names taken from frontmatter, not path.
- Hidden directories skipped (`.git/agents/x.md` is not loaded).
- Depth cap (8): use a fake `readDir` (not a fixture — avoid checking deep
  nested dirs into git) simulating ten levels deep; deeper subtree emits
  `depth exceeds 8` error; shallower files still load.
- Symlinked-directory cycle yields one `symlink cycle detected` error, not
  infinite recursion.
- Lex collision across subdirs: `a/coder.md` and `b/coder.md` both
  `name: coder`; lex-first full path wins, the other gets the duplicate-name
  error.
- Per-file failures (size cap, parse) inside subdirs still produce error
  records.

**`tool-filter.test.ts`** (extend):

- `excludeNames` filters a tool that the allowlist would have admitted.
- `excludeTags` filters a tool whose tag matches.
- Tool only in denylist (no allowlist) is filtered.
- Empty `excludeNames` / `excludeTags` arrays behave identically to absent.
- Allow + deny same name → denied (intersection).

**`frontmatter.test.ts`** (extend):

- `disallowedTools` parses into `toolFilter.excludeNames`.
- `disallowedTags` parses into `toolFilter.excludeTags`.
- Malformed `disallowedTools` (non-array) → deterministic error.
- Both allowlist and denylist round-trip correctly together.

**`registry.test.ts`** (extend):

- `setInner(next, errors)` stores errors; `getErrors()` returns a defensive
  copy.
- Initial handle has empty errors.

**`slash.test.ts`** (extend):

- Footer renders below the agent list when errors exist.
- Footer renders below `No agents registered.` when registry empty + errors
  exist.
- No footer when errors empty (existing tests pass unchanged).
- Errors render in source order.

**`dispatch.test.ts`** (add one):

- Always-on tools (`dispatch_agent`, `load_skill`) are merged in even when
  the manifest's `disallowedTools` lists them — regression guard.

No driver-runtime or harness-integration tests; the surface is per-module
and the manual smoke is covered in the local-deploy step.

## Local deploy

`llm-contracts` MUST be rebuilt and redeployed before `llm-agents`, because
the contract module is loaded first at boot:

```sh
PLUGIN=llm-contracts
VERSION=$(jq -r .version plugins/$PLUGIN/package.json)
INSTALL_DIR=~/.kaizen/marketplaces/official/plugins/${PLUGIN}@${VERSION}
(cd plugins/$PLUGIN && bun build --target=bun --outfile=dist/index.js index.ts)
mkdir -p "$INSTALL_DIR/dist"
cp plugins/$PLUGIN/dist/index.js "$INSTALL_DIR/dist/index.js"
rsync -a --exclude='node_modules' --exclude='dist' plugins/$PLUGIN/ "$INSTALL_DIR/"
```

Then `llm-agents`:

```sh
PLUGIN=llm-agents
VERSION=$(jq -r .version plugins/$PLUGIN/package.json)
INSTALL_DIR=~/.kaizen/marketplaces/official/plugins/${PLUGIN}@${VERSION}
(cd plugins/$PLUGIN && bun build --target=bun --outfile=dist/index.js index.ts)
mkdir -p "$INSTALL_DIR/dist"
cp plugins/$PLUGIN/dist/index.js "$INSTALL_DIR/dist/index.js"
rsync -a --exclude='node_modules' --exclude='dist' plugins/$PLUGIN/ "$INSTALL_DIR/"
```

No version bumps required for in-tree work; bump to `0.2.x` when releasing
publicly. Out of scope for the design.

## Migration

Existing manifests with no `disallowedTools` / `disallowedTags` are
unaffected. Top-level files in `~/.kaizen/agents/` and `.kaizen/agents/`
continue to load identically. The only observable behavior change for
existing setups is the appearance of the error footer in `/agents:list` —
which is the point.

Users with bare-markdown files (no frontmatter) such as the ones discovered
in this repo (`.kaizen/agents/coder.md`, `.kaizen/agents/reviewer.md`) will
see their files surfaced as parse errors with the path and reason, instead
of being silently dropped.
