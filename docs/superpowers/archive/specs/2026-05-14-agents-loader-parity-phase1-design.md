# Agents Loader Parity with Claude Code — Phase 1

**Status:** approved design, awaiting plan
**Scope:** `plugins/llm-agents` plus one additive contract change in `plugins/llm-contracts` plus a small additive filter extension in `plugins/llm-tools-registry`. No driver, TUI, or session-manager changes.
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
- `llm-agents` extends two pure modules (`frontmatter.ts`, `loader.ts`),
  the registry handle (`registry.ts`), the dispatch builder (`dispatch.ts`),
  and the slash renderer (`slash.ts`). The plugin's pure-factory boundary is
  preserved — only `index.ts` continues to touch `ctx`.
- `llm-tools-registry` extends `matchesFilter` in `registry.ts` to honor
  optional `excludeNames` / `excludeTags` on the filter object passed to
  `list()` / `listRegistrations()`. This is where tool filtering actually
  runs (driver's `loop.ts` calls `tools.registry.list(input.toolFilter)`);
  `plugins/llm-agents/tool-filter.ts` is an unused-at-runtime helper module
  whose `toolMatches` function is referenced only by its own unit tests, so
  it is intentionally left untouched.
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
- **Modify** `plugins/llm-tools-registry/registry.ts` — extend
  `matchesFilter` to filter out entries whose name matches any
  `excludeNames` pattern (glob via the existing match approach) or whose
  tags intersect `excludeTags`. Purely additive: filters without the new
  keys behave identically.
- **Modify** `plugins/llm-agents/dispatch.ts` — extend the merged
  `toolFilter` it passes to the driver to include `excludeNames` /
  `excludeTags` from `internal.toolFilter`. Always-on tools (`dispatch_agent`,
  `load_skill`) continue to be force-included via `mergedNames`; even if a
  manifest's denylist includes those names, the registry will still emit them
  because they're in the allowlist `names` list and `matchesFilter` short-
  circuits there. See "Always-on tool invariant" below.
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

Implementation lives in `plugins/llm-tools-registry/registry.ts`, inside
the existing `matchesFilter` function used by `list()` and
`listRegistrations()`. The filter shape is an inline structural type on
those methods; extending it is purely additive.

Updated `matchesFilter`:

```ts
function matchesFilter(
  entry: Entry,
  filter?: {
    tags?: string[]; names?: string[]; sources?: ToolSource["kind"][];
    excludeTags?: string[]; excludeNames?: string[];   // NEW
  },
): boolean {
  if (!filter) return true;
  const { tags, names, sources, excludeTags, excludeNames } = filter;
  if (names && !new Set(names).has(entry.schema.name)) return false;
  if (sources && !new Set(sources).has(entry.source.kind)) return false;
  if (tags) {
    const tagSet = new Set(tags);
    const schemaTags = entry.schema.tags ?? [];
    let any = false;
    for (const t of schemaTags) if (tagSet.has(t)) { any = true; break; }
    if (!any) return false;
  }
  if (excludeNames && new Set(excludeNames).has(entry.schema.name)) return false; // NEW
  if (excludeTags) {                                                              // NEW
    const exTagSet = new Set(excludeTags);
    const schemaTags = entry.schema.tags ?? [];
    for (const t of schemaTags) if (exTagSet.has(t)) return false;
  }
  return true;
}
```

**Matching is by exact name**, mirroring the existing allowlist behavior in
`matchesFilter`. Glob expansion is not implemented for either allowlist or
denylist today — `plugins/llm-agents/tool-filter.ts`'s `matchesGlob` is
unused at runtime. Adding glob support is a separate concern (a real
pre-existing bug, since manifests in this repo use glob-style patterns) and
is out of Phase 1 scope.

If a tool appears in both `names` and `excludeNames`, the allowlist gate
passes but the denylist gate rejects — net `return false`. Denylist wins.

`dispatch.ts` extends the merged `toolFilter` it passes to the driver:

```ts
const manifestNames = internal.toolFilter?.names ?? [];
const manifestTags = internal.toolFilter?.tags ?? [];
const excludeNames = internal.toolFilter?.excludeNames ?? [];          // NEW
const excludeTags = internal.toolFilter?.excludeTags ?? [];            // NEW
const alwaysOn: string[] = ["dispatch_agent"];
if (deps.hasSkills()) alwaysOn.push("load_skill");
const mergedNames = Array.from(new Set([...manifestNames, ...alwaysOn]));
const toolFilter = { names: mergedNames, tags: manifestTags, excludeNames, excludeTags };
```

The `tool-filter.ts` module in `llm-agents` is left untouched.

### Always-on tool invariant

The always-on tools (`dispatch_agent`, and when `skills:registry` is
present, `load_skill`) are force-merged into `toolFilter.names` by
`dispatch.ts` regardless of what the manifest declares. With exact-name
allowlist semantics, this means:

- A tool whose `schema.name === "dispatch_agent"` always matches the
  allowlist gate (it's in `mergedNames`).
- The same name in `excludeNames` would cause `matchesFilter` to return
  `false` for that tool — denying away the always-on tool.

To preserve the invariant, `dispatch.ts` must subtract the always-on names
from the `excludeNames` array before passing the filter through. The
updated assembly:

```ts
const alwaysOnSet = new Set(alwaysOn);
const filteredExcludeNames = excludeNames.filter((n) => !alwaysOnSet.has(n));
const toolFilter = {
  names: mergedNames,
  tags: manifestTags,
  excludeNames: filteredExcludeNames,
  excludeTags,
};
```

This keeps the rule "always-on tools cannot be opted out of, even by
denylist." Tags-based denial of always-on tools is also possible in
principle (e.g., if `dispatch_agent` were tagged `meta` and a manifest
said `disallowedTags: ["meta"]`) — but `dispatch_agent` and `load_skill`
ship with no tags today, so it's a non-issue. We do not strip tags from
`excludeTags`; any future always-on tool that introduces tags must
self-tag conservatively.

Regression test in `dispatch.test.ts` exercises both:
1. `disallowedTools: ["dispatch_agent"]` — the tool still appears in the
   resulting `toolFilter` (verifying the strip happens).
2. `disallowedTags: ["future-meta-tag"]` where `dispatch_agent` has no
   tags — the tool still appears (verifying no accidental denial via
   absent tags).

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
tools: ["read_file", "list_files"]
tags: ["read-only"]
disallowedTools: ["edit_file", "write_file"]
disallowedTags: ["destructive"]
model: gpt-4o-mini
---
You are a focused code reviewer. ...
```

Tool-filter worked example. Tool registry exposes `edit_file` with tags
`["fs", "destructive"]`:

- Agent with `tools: ["read_file"]`, no denylist → `edit_file` filtered
  (not in allowlist).
- Agent with `tools: ["edit_file"]`, `disallowedTools: ["edit_file"]` →
  filtered (denylist wins over allowlist).
- Agent with no allowlist, `disallowedTags: ["destructive"]` → filtered
  (denied by tag).
- Agent with no allowlist, no denylist → passes (existing behavior).

Note: matching is exact-name. Glob patterns like `read_*` are not honored
by `matchesFilter` today; this is a pre-existing bug across both
allowlist and denylist and is out of Phase 1 scope.

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

**`plugins/llm-tools-registry/test/registry.test.ts`** (extend) — owns the
runtime filter:

- `excludeNames` filters out a tool that the allowlist would have admitted
  (allow=[a, b], excludeNames=[b] → only `a` returned).
- `excludeTags` filters out a tool whose schema tag is in the denylist.
- Tool only in denylist (no allowlist defined) is filtered out.
- Empty `excludeNames` / `excludeTags` arrays behave identically to absent.
- Filter without any exclude fields still works exactly as before
  (backwards-compat regression).

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

**`dispatch.test.ts`** (extend):

- The merged `toolFilter` passed to the driver carries `excludeNames` and
  `excludeTags` from `internal.toolFilter`.
- Always-on tool names (`dispatch_agent`, `load_skill`) are stripped from
  `excludeNames` before the filter is built — regression guard. Spec case:
  manifest sets `disallowedTools: ["dispatch_agent"]`; verify the resulting
  `toolFilter.excludeNames` does NOT contain `dispatch_agent` and
  `toolFilter.names` still does.
- A manifest with no `disallowedTools` / `disallowedTags` produces a
  `toolFilter` with `excludeNames: []` and `excludeTags: []` (or those
  fields absent — pick one and pin it in the test).

No driver-runtime or harness-integration tests; the surface is per-module
and the manual smoke is covered in the local-deploy step.

## Local deploy

Three plugins must be redeployed in dependency order: `llm-contracts` (the
contract change), `llm-tools-registry` (the filter extension), then
`llm-agents` (the loader/dispatch/registry/slash changes).

`llm-contracts` MUST be rebuilt and redeployed first, because the contract
module is loaded before any provider at boot:

```sh
PLUGIN=llm-contracts
VERSION=$(jq -r .version plugins/$PLUGIN/package.json)
INSTALL_DIR=~/.kaizen/marketplaces/official/plugins/${PLUGIN}@${VERSION}
(cd plugins/$PLUGIN && bun build --target=bun --outfile=dist/index.js index.ts)
mkdir -p "$INSTALL_DIR/dist"
cp plugins/$PLUGIN/dist/index.js "$INSTALL_DIR/dist/index.js"
rsync -a --exclude='node_modules' --exclude='dist' plugins/$PLUGIN/ "$INSTALL_DIR/"
```

Then `llm-tools-registry`:

```sh
PLUGIN=llm-tools-registry
VERSION=$(jq -r .version plugins/$PLUGIN/package.json)
INSTALL_DIR=~/.kaizen/marketplaces/official/plugins/${PLUGIN}@${VERSION}
(cd plugins/$PLUGIN && bun build --target=bun --outfile=dist/index.js index.ts)
mkdir -p "$INSTALL_DIR/dist"
cp plugins/$PLUGIN/dist/index.js "$INSTALL_DIR/dist/index.js"
rsync -a --exclude='node_modules' --exclude='dist' plugins/$PLUGIN/ "$INSTALL_DIR/"
```

Finally `llm-agents`:

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
