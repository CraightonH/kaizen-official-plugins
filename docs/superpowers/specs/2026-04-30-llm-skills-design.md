# `llm-skills` — Skill Discovery & Injection (Spec 7)

> **Note:** Config paths use the `~/.kaizen/<subdir>/` convention. See Spec 0 for rationale.

**Status:** draft
**Date:** 2026-04-30
**Depends on:** Spec 0 (`2026-04-30-openai-compatible-foundation-design.md`), Spec 3 (`llm-tools-registry`)
**Scope:** The `llm-skills` plugin. Discovers markdown-based skill files on disk, exposes manifests via `skills:registry`, injects available-skill descriptions into the system prompt at turn start, and registers a synthetic `load_skill` tool so the LLM can pull a skill body into context on demand.

## Goal

Give the LLM a Claude-Code-style skill mental model in the openai-compatible harness:

- Users drop markdown files with YAML frontmatter into known directories.
- On every turn, the LLM sees a short list of available skills (one line each).
- When the LLM decides it needs a skill, it calls `load_skill({ name })`. The body comes back as a tool result, ending up in the conversation context for the next assistant turn.

This keeps the steady-state token cost low (one line per skill) and only spends the body's tokens when actually needed.

## Non-goals

- Authoring tools / templating (skills are plain markdown — users edit them in any editor).
- Live file watching. Scan-on-turn-start with cache is sufficient (see *Refresh*).
- Provider-exact token counting. Heuristic only; providers may recompute later.
- Cross-session persistence of "loaded" state. A loaded skill lives in the conversation transcript like any other tool result; if the conversation is cleared, it's gone.
- Validating the *content* of skill bodies. Whatever the user writes is whatever the LLM sees.

## Architectural overview

The plugin owns three responsibilities:

1. **Discovery & registry.** Scan configured roots, parse frontmatter, build an in-memory map of `name → { manifest, loader }`. Allow other plugins to register synthetic skills programmatically.
2. **System-prompt injection.** Subscribe to `llm:before-call` (Spec 0 § *LLM call*). Mutate `request.systemPrompt` in-place to append an "Available skills" section listing every registered manifest.
3. **Tool surface.** Register a `load_skill` tool into `tools:registry` (Spec 0 § *`tools:registry`*). When invoked, look up the manifest, call its loader, emit `skill:loaded`, and return the body as the tool result. The dispatch strategy (native or codemode) returns that body to the LLM as a tool message — the LLM then has the skill content available for its next turn.

The plugin is read-only with respect to the filesystem and never executes anything from a skill body. Permission tier is `trusted` (matches `llm-events`, `claude-events`).

## Disk layout & file format

### Search paths (in lookup order, highest priority first)

1. `<project>/.kaizen/skills/` — project-scoped. Project root is resolved via `ctx.cwd` at plugin start.
2. `~/.kaizen/skills/` — user-scoped.
3. Plugin-registered skills via `skillsRegistry.register(manifest, loader)` — lowest priority.

Both directories are optional. If neither exists, the registry is simply empty plus whatever plugins register.

A `KAIZEN_LLM_SKILLS_PATH` env var MAY be honored as a colon-separated override of the default user path. Project path is never overridable (it's tied to the working tree).

### File extension

`.md` only. Other extensions are ignored.

### Subdirectories & name derivation

Skills nested in subdirectories are namespaced by their relative path. Example layout:

```
~/.kaizen/skills/
  git-rebase.md          → name "git-rebase"
  python/
    poetry-deps.md       → name "python/poetry-deps"
  ops/
    k8s/
      kubectl-debug.md   → name "ops/k8s/kubectl-debug"
```

Rule: name = relative path from the search root, with `.md` stripped, using `/` as separator on all platforms (Windows backslashes are normalized).

### Frontmatter contract

```markdown
---
name: git-rebase
description: How to do a clean interactive rebase without losing work.
tokens: 420            # optional; if absent, computed at registration
---
# Body starts here

Step 1...
```

- `name` (required, string): MUST match the path-derived name. If it disagrees, the plugin logs a warning and prefers the path-derived name (the LLM-visible identifier must be predictable from the disk layout).
- `description` (required, string, single line preferred): the line shown to the LLM in the system prompt.
- `tokens` (optional, integer): manual override of the heuristic estimate.

If frontmatter is missing or invalid, the file is skipped and a warning is emitted via `session:error` (non-fatal). The plugin never throws during scan — one bad file should not break the harness.

## Token estimation

Cached at registration time. Heuristic: `Math.ceil(body.length / 4)`. Documented as **approximate**; downstream providers may recompute exactly when budgeting context. The cached value is what surfaces on `SkillManifest.tokens` and on the `skill:loaded` event.

Rationale: avoids a tokenizer dependency in this plugin. The codemode/native dispatchers and `openai-llm` already handle token accounting on the response side, and the system-prompt injection only emits descriptions (cheap), not bodies.

## Conflict resolution

When the same `name` appears in multiple sources, precedence is:

1. Project (`<project>/.kaizen/skills/`) wins.
2. Then user (`~/.kaizen/skills/`).
3. Then plugin-registered skills.

When a higher-priority source masks a lower one, the masked entry is dropped and a single `console.warn`-style log line is emitted (not an event — this is a config-time concern, not a runtime one).

`name` collisions within the *same* source (e.g. two project files producing the same path-derived name — only possible via case-insensitive filesystems) are reported via `session:error` and the second is dropped.

## Refresh strategy

**Default:** scan-on-turn-start, cached.

- Plugin start: perform an initial scan, populate the registry.
- On `turn:start`: if more than `SKILL_RESCAN_INTERVAL_MS` (default 30 s) has elapsed since the last scan, re-scan. Otherwise reuse the cached registry.
- The scan is cheap (stat + frontmatter parse on a handful of files). Doing it once per turn is fine.

**Explicit refresh:** a `/skills reload` slash command is reserved for `llm-slash-commands` (Spec 8) to wire up later. It calls a `skillsRegistry.rescan()` method (added below) which forces an immediate scan and emits `skill:available-changed`.

**No file watcher.** Watcher complexity (cross-platform, debouncing, restart handling) is not justified for a directory that changes a handful of times per session.

## Service interface

Spec 0 defines `SkillsRegistryService`. This spec adds one method (`rescan`) that's plugin-internal-but-callable for the slash command. The Spec 0 contract is amended via the propagation rule (see *Changelog* below).

```ts
export interface SkillsRegistryService {
  list(): SkillManifest[];
  load(name: string): Promise<string>;
  register(manifest: SkillManifest, loader: () => Promise<string>): () => void;
  rescan(): Promise<void>;   // added by Spec 7
}
```

Behavior:

- `list()` returns manifests sorted by name. Stable, cheap, called on every turn.
- `load(name)` resolves the loader, returns the body. Throws if `name` is unknown. Emits `skill:loaded` on success.
- `register(...)` is for other plugins. Returns an unregister fn. Manifests registered this way participate in conflict resolution at the lowest priority.
- `rescan()` re-walks all search paths, rebuilds the file-backed half of the registry (plugin registrations are preserved), and emits `skill:available-changed` if the visible set changed.

## System-prompt injection

Subscriber on `llm:before-call`. Spec 0 declares the payload as mutable.

Behavior: append a section to `request.systemPrompt`. If `systemPrompt` is undefined, set it to just the section. Format:

```
## Available skills

The following skills can be loaded on demand. Each has a name, description, and a rough token cost. Call the `load_skill` tool with `{ "name": "<name>" }` to pull a skill's full content into your context for the next turn. Only load a skill when it's clearly relevant — loading is not free.

- git-rebase (~420 tokens): How to do a clean interactive rebase without losing work.
- python/poetry-deps (~180 tokens): Adding, upgrading, and locking Poetry dependencies.
- ops/k8s/kubectl-debug (~310 tokens): Debug a misbehaving pod step by step.
```

Rules:

- The section is appended with a leading blank line if `systemPrompt` is non-empty, so it doesn't run into existing content.
- If `list()` is empty, the section is omitted entirely (no empty header).
- Token estimate is shown to give the LLM a budget signal. Format `~N tokens` (the tilde signals approximation).
- Descriptions are emitted single-line. Embedded newlines in `description` are replaced with spaces before injection.
- Never inject bodies here. That's the whole point of `load_skill`.

## `load_skill` tool

Registered into `tools:registry` at plugin start.

```ts
{
  name: "load_skill",
  description: "Load the full body of a named skill into context. Use this only when the skill is clearly relevant — it consumes context tokens.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Skill name as listed in the Available skills section." }
    },
    required: ["name"],
    additionalProperties: false
  },
  tags: ["skills", "synthetic"]
}
```

Handler behavior:

1. Validate `args.name` is a non-empty string. Throw `ToolError` otherwise (caught by `tools:registry.invoke`).
2. Call `registry.load(name)`. If it throws (unknown name), let the error propagate; the registry will emit `tool:error` and the LLM gets a useful message back.
3. Return an object the dispatch strategy can stringify: `{ name, tokens, body }`. Native dispatch JSON-serializes tool results, code-mode dispatch passes the return value through to the sandbox; either way the body lands in the next-turn context as a tool message (see Spec 0 § *Tool execution*).
4. Emit `skill:loaded` with `{ name, tokens }`. (`tools:registry` already emits `tool:before-execute`/`tool:result` around the handler — no need to duplicate.)

Note that the LLM sees the body via the standard tool-message flow defined in Spec 0; this plugin doesn't have to do anything custom to plumb it back in.

## Events

Defined by `llm-events` (Spec 0 § *Skills*); this plugin is the only emitter.

| Event | When | Payload |
|---|---|---|
| `skill:loaded` | After `load_skill` handler resolves successfully. | `{ name, tokens }` |
| `skill:available-changed` | After plugin start scan, after each `rescan()` if the visible set differs, after each `register()`/unregister that changes visibility. | `{ count }` |

Both subscribers are advisory (e.g. status-bar plugins counting available skills). The driver does not depend on them.

## Plugin lifecycle

1. **Start:**
   - Resolve search paths.
   - Initial scan. Build registry.
   - Subscribe to `llm:before-call` (system-prompt injection).
   - Register `load_skill` into `tools:registry`. Capture the unregister fn.
   - Provide `skills:registry` service.
   - Emit `skill:available-changed` once with the initial count.
2. **Per turn (`turn:start` subscriber):** maybe-rescan based on `SKILL_RESCAN_INTERVAL_MS`.
3. **Per LLM call (`llm:before-call` subscriber):** mutate `request.systemPrompt`.
4. **Per `load_skill` invocation (tool handler):** load body, emit event, return.
5. **Stop:** unregister `load_skill`, drop subscriptions, drop service.

## Permissions

`tier: "trusted"`.

Justification:

- Reads files from `~/.kaizen/skills/` and `<project>/.kaizen/skills/`.
- No filesystem writes.
- No process execution.
- No network.

Equivalent posture to `llm-events`/`claude-events`.

## Test plan

Unit tests (Bun test runner, matching existing plugins):

1. **Discovery — basic.** Fixture dir with three flat `.md` files, valid frontmatter. Expect `list()` to return three manifests, sorted by name.
2. **Discovery — subdirectories.** Fixture with `python/foo.md` and `ops/k8s/bar.md`. Expect names `python/foo` and `ops/k8s/bar`.
3. **Discovery — invalid frontmatter is skipped.** Fixture with one good file and one with malformed YAML. Expect one manifest, one `session:error` event captured.
4. **Discovery — missing `description`.** Skipped, error logged, doesn't crash.
5. **Frontmatter — `name` mismatch.** Frontmatter says `name: foo`, file is `bar.md`. Expect path-derived name (`bar`) to win, warning logged.
6. **Frontmatter — `tokens` override.** Frontmatter `tokens: 999`, body has 4 chars. Expect `manifest.tokens === 999`, not heuristic.
7. **Token heuristic.** Body 400 chars, no override. Expect `tokens === 100`.
8. **Conflict resolution.** Same `name` in project, user, and plugin-registered. Expect project wins; `list()` returns the project body when `load()` is called; warning logged for masked entries.
9. **`register()` and unregister.** Plugin-registered skill appears in `list()`, `unregister()` removes it, `skill:available-changed` fired both times.
10. **`load(name)` happy path.** Body returned matches file content sans frontmatter; `skill:loaded` event fired with correct `tokens`.
11. **`load(name)` unknown.** Throws; no event.
12. **`load_skill` tool — happy path.** Register a fixture skill, invoke through `tools:registry.invoke("load_skill", { name })`. Expect return value `{ name, tokens, body }`, `tool:before-execute` / `tool:result` / `skill:loaded` events all fired in order.
13. **`load_skill` tool — bad args.** `invoke("load_skill", { name: "" })` and `invoke("load_skill", {})` both surface `tool:error`.
14. **System-prompt injection — empty registry.** `llm:before-call` fired with `systemPrompt: "base"`. Expect `request.systemPrompt === "base"` (no `## Available skills` section).
15. **System-prompt injection — populated.** Two skills. Expect format-string match including header, both bullet lines, `~N tokens` formatting, and a leading blank line preserving the original `systemPrompt`.
16. **System-prompt injection — undefined input.** Original `systemPrompt` undefined. Expect it set to just the section (no leading blank line).
17. **System-prompt injection — multiline description sanitized.** Description with `\n` becomes a single line in the injection.
18. **`rescan()` adds and removes.** Add a file to fixture dir, call `rescan()`, expect new entry in `list()` and `skill:available-changed`. Delete it, rescan, gone.
19. **Scan-on-turn-start cache.** Two `turn:start` events within `SKILL_RESCAN_INTERVAL_MS` cause one scan; a third after the interval causes a second scan. (Spy on the scan function.)
20. **Permission tier sanity.** `plugin.json` declares `tier: "trusted"`.

Integration tests (one or two, using a real `tools:registry` and `llm-events`):

- End-to-end: start the plugin, fire a synthetic `llm:before-call`, assert the prompt mutated; then invoke `load_skill` through the registry, assert the returned body matches.

## Acceptance criteria

- Plugin builds, all unit + integration tests pass.
- Service `skills:registry` exposes `list`, `load`, `register`, `rescan`.
- `load_skill` is present in `tools:registry.list()` after start with tag `skills`.
- A C-tier harness file (`harnesses/openai-compatible.json`) including `official/llm-skills` boots without errors and shows the "Available skills" section in `llm:request` payloads when at least one skill is on disk.
- Marketplace `entries` updated for `llm-skills`.

## Open questions

- **Multi-file skills?** Claude Code allows a `SKILL.md` plus sibling files (scripts, references). For v1 we accept only single `.md` files. If users need multi-file later, we extend by recognizing a directory containing `SKILL.md` (name = directory's relative path) and exposing sibling paths via a separate API. Out of scope here.
- **Description length cap?** Long descriptions blow up the system prompt. Recommend a soft cap (e.g. 200 chars) enforced with a warning, but defer the policy to v1.1 once we see real-world usage.
- **Body-size cap on `load_skill`?** A 50k-token skill body could blow the context window. Defer enforcement to the dispatch strategies / driver, which already need a context-budget story.

## Changelog

- **2026-04-30:** Initial draft. Adds `rescan()` to Spec 0's `SkillsRegistryService` interface — propagation back into Spec 0 required before merging this spec.
