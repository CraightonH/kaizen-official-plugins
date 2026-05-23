# `new_skill` tool + CC-shaped on-disk layout for `llm-skills`

Date: 2026-05-23
Owner plugin: `llm-skills`
Related: `docs/TODO.md` item #1; prior `2026-05-23-skills-slash-commands-design.md`

## Goal

Let the LLM author a new skill at conversation time without reverse-engineering disk layout, frontmatter shape, or naming rules. A structured tool input (discrete frontmatter fields + body + scope selector) and a deterministic write path remove the "guess where the file goes" problem entirely.

In service of that, this spec also moves `llm-skills`'s on-disk layout from flat `<root>/<name>.md` to CC-style directory-per-skill `<root>/<name>/SKILL.md`. The two changes are interlocked — `new_skill` has to write *something*, and aligning the kaizen-native layout with CC's keeps the LLM's mental model symmetric across the two skill sources (`llm-skills` for kaizen-native, `claude-skills` for CC shim).

## Non-goals

- **Updating or editing an existing skill.** Create-only. If the LLM (or user) needs to replace a skill, they delete the directory by hand and re-author. A future `edit_skill` tool can be specced independently once usage shows a real need.
- **Multi-file skill authoring.** This tool writes exactly one file (`SKILL.md`) into the skill's directory. Sibling files (`references/`, `scripts/`) remain a manual concern; the tool does not scaffold them.
- **Migration of any existing flat `<root>/<name>.md` skills.** Zero adoption today; the new walker simply stops seeing them. No deprecation warning, no auto-rewrite.
- **Mutating `claude-skills` sources.** `claude-skills` remains a read-only shim of CC's `~/.claude/skills/` and project equivalents. `new_skill` writes only under `~/.kaizen/skills/` or `<cwd>/.kaizen/skills/`.
- **Richer frontmatter** (e.g. `allowed-tools`, license fields). Stay minimal until a concrete consumer needs it.

## User stories

- **Author mid-conversation.** "We keep doing this thing — make a skill out of it." → LLM calls `new_skill` with `name`, `description`, `body`, `scope`. The approval gate prompts the user. After approval, the file is on disk and the next turn's system prompt advertises it.
- **Confirm and reference.** The tool returns the final registered name, the absolute path, and the computed token count. The LLM can quote those back to the user ("wrote `git-workflow` to `/Users/.../SKILL.md`, ~340 tokens") and immediately use `load_skill` against it on a subsequent turn if needed.

## Architecture

### Layout change (refactor of `scan.ts`)

`llm-skills`'s scanner walks the same two roots as today but with CC's shape:

```
<cwd>/.kaizen/skills/<name>/SKILL.md      # project layer
~/.kaizen/skills/<name>/SKILL.md          # user layer
```

`<name>` is a single path segment; nesting is not supported in v1 (deferred, see "Decisions"). Each scanned skill carries `baseDir` = the absolute path of `<name>/` (matching what `claude-skills` already does for CC skills), so `load_skill`'s existing "prepend `Base directory for this skill: <baseDir>`" behavior keeps working uniformly.

`scan.ts` changes:

- Walk `<root>/*/SKILL.md` rather than `<root>/**/*.md`.
- `relativeName` is the immediate parent directory name.
- `absolutePath` is the `SKILL.md` file; `baseDir` is its parent directory.
- Files at depth > 1 (e.g. `<root>/group/name/SKILL.md`) are ignored — flat names only.
- Anything in a skill directory other than `SKILL.md` is left alone (references, scripts, etc.).
- Flat `<root>/<name>.md` files are not scanned. No warning, no migration.

`scan.ts` is still the only module doing filesystem I/O; the rest of the plugin's module map is unchanged.

### New module: `new-skill.ts`

```
new-skill.ts    NEW_SKILL_SCHEMA + makeNewSkillHandler({ projectRoot, userRoot, registry, emit, log })
                Pure factory. Validates input, computes target path, refuses on collision,
                writes SKILL.md (mkdir -p the skill dir, then atomic write), triggers
                registry rescan, returns { name, path, scope, tokens }. No module-scope state.
```

The handler:

1. **Validate input** (synchronous):
   - `scope` is `"project"` or `"user"`.
   - `name` matches `/^[a-z0-9][a-z0-9_-]*$/`, ≤ 64 chars.
   - `description` non-empty after trim, single-line (no `\n` or `\r`), ≤ 200 chars.
   - `body` non-empty after trim.
   - On any failure, throw with a message naming the field and the rule violated.
2. **Resolve target path**: `<projectRoot or userRoot>/<name>/SKILL.md`.
3. **Collision check**: `stat` the skill directory. If anything exists at that path (file, dir, symlink), throw `skill '<name>' already exists at <abs path>`. The check uses `lstat` so symlinks at the target are treated as collisions, not followed.
4. **Compose file body**:
   ```markdown
   ---
   name: <name>
   description: <description>
   ---

   <body>
   ```
   The frontmatter `name:` is informational only — path-derived name remains canonical — but writing it keeps the file consistent for humans editing later.
5. **Write**: `mkdir` the skill directory (mode 0o755), then write `SKILL.md` (mode 0o644). Use a write-then-rename pattern to keep the operation atomic against partial-file observations by a concurrent rescan.
6. **Reconcile**: `await registry.rescan()`. The registry's `onChange` callback (see "Reconciliation refactor" below) bumps the prompt-section generation and emits `skill:available-changed`.
7. **Return**: `{ name, path, scope, tokens }`. `tokens` is read from the freshly-rescanned registry entry; if the entry is somehow missing (shouldn't happen but defensive), fall back to `estimateTokens(body)`.

### Reconciliation refactor

Currently `index.ts` does:

```ts
// in setup()
onChange: () => { sectionHandle?.bumpGeneration(); },

// in turn:start handler
if (r.changed) {
  void ctx.emit("skill:available-changed", { count: r.count });
  sectionHandle?.bumpGeneration();
}
```

The duplicated bump (once via `onChange` for programmatic changes, once inline for rescan-detected changes) is bug-prone — any new caller of `rescan()` (like `new_skill`) has to remember to bump separately. Fix:

- `registry.rescan()` invokes `onChange` itself when `changed === true`.
- The setup-time `onChange` callback becomes the single site for both the section bump and the emit:

  ```ts
  onChange: (info?: { count: number }) => {
    sectionHandle?.bumpGeneration();
    if (info) void ctx.emit("skill:available-changed", { count: info.count });
  },
  ```

- The `turn:start` handler reduces to `await registry.rescan()`.
- Programmatic `register()`/unregister also flow through the same callback (they pass no `info`, so they bump-but-don't-emit, matching today's behavior).

This refactor is small but load-bearing for the new tool: `new_skill`'s only reconciliation responsibility is `await registry.rescan()`, and the existing wiring takes care of bumping + emitting.

### Wiring in `index.ts`

After the existing `load_skill` registration:

```ts
if (tools) {
  // ... existing load_skill registration ...

  const newSkillHandler = makeNewSkillHandler({
    projectRoot,
    userRoot,
    registry,
    emit: (event, payload) => ctx.emit(event, payload),
    log: (m) => ctx.log(m),
  });
  unregisterNewSkill = tools.registerWith({
    schema: NEW_SKILL_SCHEMA,
    handler: newSkillHandler,
    source: { kind: "skill" },
  });
}
```

`unregisterNewSkill` joins the existing module-scope cleanup handles, drained in `stop()`.

No new `services.consumes` entries — `tools:registry` already declared; no other service needed.

## Tool surface

```jsonc
{
  "name": "new_skill",
  "description": "Author a new kaizen-native skill from this conversation. Writes a SKILL.md file with the supplied frontmatter and body to either the project's .kaizen/skills/ directory or the user's ~/.kaizen/skills/ directory. Refuses if a skill with that name already exists in the target scope. The new skill is registered before the tool returns.",
  "parameters": {
    "type": "object",
    "properties": {
      "name":        { "type": "string", "description": "Skill name. Single segment, lowercase, [a-z0-9_-], starting with [a-z0-9]. Becomes the directory name under the scope's root." },
      "description": { "type": "string", "description": "One-line description shown to the LLM in the Available skills prompt section. ≤200 chars, no newlines." },
      "body":        { "type": "string", "description": "Markdown body of the skill (the part after the frontmatter). Non-empty." },
      "scope":       { "type": "string", "enum": ["project", "user"], "description": "Where to write: 'project' for <cwd>/.kaizen/skills/, 'user' for ~/.kaizen/skills/." }
    },
    "required": ["name", "description", "body", "scope"],
    "additionalProperties": false
  },
  "tags": ["skills", "synthetic", "mutating"]
}
```

### Return shape

On success:

```jsonc
{
  "name":   "<final registered name>",
  "path":   "<absolute path to SKILL.md>",
  "scope":  "project" | "user",
  "tokens": <number>
}
```

On error: thrown — `tools:registry` surfaces it as `tool:error`. Messages identify which field/rule/path failed.

## Approval

The tool routes through `llm-tool-approval` with no special-casing in `llm-skills`:

- Tool name `new_skill` does **not** match the shipped default allow rule `llm-skills:*`, so the gate prompts by default.
- Standard prompt options apply: Approve Once / Approve Always / Approve Pattern Always / Approve Domain Always / Deny.
- "Approve Always" would persist `new_skill` in the project's approval config — a per-project trust decision the user makes consciously.
- The `"mutating"` tag is set on the schema as a soft hint for future approval-UI work; nothing reads it today.

No further plumbing in this spec — the approval surface is whatever the existing gate provides.

## Decisions

### Create-only, not upsert or update

A separate `edit_skill` tool is the right shape for replace semantics. Bundling create+update into one tool blurs intent and makes the collision branch a footgun. Until we have evidence the LLM needs to update its own skills, the cleanest contract is: writes never destroy existing content.

### Flat names, not nested

Mirrors CC's `<root>/<name>/SKILL.md` exactly, keeping the mental model symmetric across `claude-skills` (which shims CC) and `llm-skills`. Nesting can be added in a follow-up by walking one level deeper and joining with `/`; nothing in this spec forecloses it. We just don't pay the design cost up-front.

### No migration of existing flat skills

Adoption is zero. A heads-up warning would only be heard by the spec author. Cheaper to keep the scanner narrow.

### `tokens` is not a tool input

The token count is a budget signal for the prompt-section render, not a skill property the LLM should hand-roll. The existing `estimateTokens` heuristic runs at registration. Frontmatter `tokens:` from human-authored files is still honored by the parser — this spec doesn't change that surface; it just keeps the tool from emitting one.

### Scope is required (no default)

A skill is either workspace-specific or globally useful. That's a real authoring decision the LLM has the context to make. Defaulting to either invites footguns: "project" silently bounds reusable skills, "user" silently leaks project-specific skills.

### Cross-layer masking is allowed; only same-scope collisions refuse

The existing precedence is project > user > programmatic, with a `warn` emitted on masking. That semantic is correct: if the LLM picks `scope: "project"` for a name that already exists at user scope, the user explicitly asked for an override. The tool's collision check is filesystem-level only — does the target path already have a directory? — not registry-level.

### Reconciliation: immediate full rescan

A targeted "patch the registry in place" path is faster but creates a transient state where the same name briefly exists as both programmatic and file-backed. A full rescan reuses existing code, completes in the same tool call, and leaves the registry in the same shape it would reach naturally on the next `turn:start`.

The registry-side refactor (rescan invokes `onChange` on changed) is justified independently — it removes the bump-and-emit duplication between `turn:start` and any other rescan trigger.

## Validation

| Field | Rule | On violation |
|---|---|---|
| `scope` | `"project"` or `"user"` | throw `scope must be "project" or "user"` |
| `name` | `/^[a-z0-9][a-z0-9_-]*$/`, ≤ 64 chars | throw with the failing rule named (`name must match [a-z0-9_-], starting with [a-z0-9]` or `name must be ≤ 64 chars`) |
| `description` | non-empty after trim, no `\n`/`\r`, ≤ 200 chars | throw with the failing rule |
| `body` | non-empty after trim | throw `body must be non-empty` |
| target dir | nothing at `<root>/<name>` (via `lstat`) | throw `skill '<name>' already exists at <abs path>` |

Filesystem failures (`mkdir`, `writeFile`) bubble verbatim — they're rare and the message is already informative.

## Error handling

- Validation errors and collision errors throw before any disk write. The tool is atomic on the failure side: either everything happened (file on disk + registry updated) or nothing did.
- `mkdir` is recursive (`{ recursive: true }`) so a missing root (`.kaizen/skills/`) is created on first write. The root inherits filesystem permissions of its parent.
- The write-then-rename pattern (`SKILL.md.tmp-<pid>-<nonce>` → `SKILL.md`) avoids a half-written file being picked up by a concurrent `turn:start` rescan. Cost is one extra rename per write; do it.
- Post-write rescan failures (`registry.rescan()` throws) are surfaced as tool errors. The file is on disk but the registry didn't pick it up; the next `turn:start` rescan would. The error message names this clearly so the user understands the file is written.

## Testing

`test/new-skill.test.ts` under `llm-skills`. Pattern matches existing `tool.test.ts` — pass a fake registry + fake emit, drive the handler directly.

Cases:

**Validation**
- Missing each required field → throws with field name in message.
- Bad `name` (uppercase, `..`, `/`, leading dash, > 64 chars) → throws with the rule.
- `description` with `\n` → throws.
- `description` > 200 chars → throws.
- `body` whitespace-only → throws.
- `scope` = `"global"` → throws.

**Filesystem behavior** (using a tmp dir fixture)
- Happy path: creates `<root>/foo/SKILL.md` with correct frontmatter and body; calls `registry.rescan()` once; returns `{ name, path, scope, tokens }` with the rescanned token count.
- Collision: pre-existing `<root>/foo/SKILL.md` → throws, no write occurred.
- Collision: pre-existing `<root>/foo/` directory with no SKILL.md → still throws (we treat the directory itself as the collision).
- Collision: pre-existing symlink at `<root>/foo` → throws (lstat, don't follow).
- Missing root (`.kaizen/skills/` doesn't exist yet) → mkdir-recursive creates it; write succeeds.

**Scope selection**
- `scope: "project"` writes under the project root; `scope: "user"` writes under the user root.

**Layout refactor (`scan.ts`)**
Update `test/scan.test.ts` (and any fixture trees) to reflect the new walker:
- Discovers `<root>/foo/SKILL.md` as name `foo`.
- Ignores `<root>/foo.md` (flat, no longer supported).
- Ignores `<root>/foo/notes.md` (sibling files, not SKILL.md).
- Ignores `<root>/group/foo/SKILL.md` (nested, not yet supported).
- Sets `baseDir` to the skill's directory.

**Integration**
- `index.test.ts`: fake `tools:registry` + fake `prompt:registry`, drive a `new_skill` call end-to-end, assert that the next `registry.list()` includes the new skill, the prompt-section generation bumped, and `skill:available-changed` was emitted exactly once.

## Local deploy

Standard `llm-skills` deploy flow — see that plugin's `CLAUDE.md`. After changes:

```sh
mkdir -p ~/.kaizen/marketplaces/official/plugins/llm-skills@0.1.2/
cp -R plugins/llm-skills/. ~/.kaizen/marketplaces/official/plugins/llm-skills@0.1.2/
(cd ~/.kaizen/marketplaces/official/plugins/llm-skills@0.1.2 \
  && bun build --target=bun --outfile=dist/index.js index.ts)
```

The version bump (0.1.2 → 0.1.3 likely, given the layout change is a behavior break for any pre-existing flat skills) is settled at plan time, not in this spec.

## Follow-ups (out of scope)

- **`edit_skill`** — replace-in-place tool for an existing skill. Different approval surface (since it can destroy content), different validation (target must exist, not must-not-exist).
- **`delete_skill`** — likely paired with `edit_skill`. Same approval class.
- **Nested kaizen skills** — `<root>/group/name/SKILL.md` → registered as `group/name`. Reintroduce nesting once the flat layout demonstrates a real organizational pain point.
- **Pass-through richer frontmatter** — `allowed-tools` etc. if/when the registry or downstream consumers actually use those fields.
