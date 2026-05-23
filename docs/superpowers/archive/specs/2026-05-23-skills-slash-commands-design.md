# Skills slash commands (`/skills:list`, `/skills:get`)

Date: 2026-05-23
Owner plugin: `llm-skills`
Related: `docs/todo.md` item #1

## Goal

Give users a TUI-facing surface for inspecting the skills registry, without bolting skills onto the bare `/` namespace or mixing them with built-in commands. Use the existing namespaced slash convention (`/<plugin>:<command>`) so skills get their own discoverable corner.

## Non-goals

- LLM invocation of skills. Skills continue to load via the existing `load_skill` tool. Slash commands do not inject skill bodies into the conversation, do not nudge the LLM toward `load_skill`, and do not mutate the registry.
- A `/skills:use` (or `:reference`, `:mention`) verb. Considered and rejected — see "Decisions" below.
- Disk mutation (skill authoring). Tracked separately in `docs/todo.md` item #2 (`new_skill` tool).
- Anything in `claude-skills`. That plugin remains a pure producer of programmatic registrations into `skills:registry`.

## User stories

- **Discovery.** "What skills are available right now in this session?" → `/skills:list` dumps name + description for every registered skill.
- **Inspection.** "What does this skill actually say?" → `/skills:get <name>` dumps the skill's source path, token count, and rendered body.

## Architecture

The two commands live in `llm-skills`, the plugin that already owns `skills:registry`. They use the registry directly via the in-process reference (no `useService` round-trip), and they register against `slash:registry` via `useService`.

Adds a new module to `llm-skills`:

```
slash-commands.ts   registerSlashCommands({ registry, slash, print }) → unregister()
                    Pure factory. Registers /skills:list and /skills:get against the
                    passed slash registry. Returns a single function that undoes both
                    registrations. No filesystem, no ctx, no module-scope state.
```

Wiring in `index.ts`:

- After the existing `skills:registry` setup, attempt `ctx.useService<SlashRegistryService>("slash:registry")` inside a try/catch.
- If present, call `registerSlashCommands({ registry, slash })` and stash the returned `unregister` in module scope.
- On `stop()`, drain the unregister alongside the existing teardown.
- `slash:registry` is **optional** — harnesses without slash commands (e.g. CC's claude-wrapper harness, where CC owns the slash surface) must continue to load `llm-skills` without error.

**Dependency style: topo-hint optional** (per `PLUGIN_ARCHITECTURE.md` §"Optional service dependencies"). Declare `"slash:registry"` in `services.consumes` so kaizen orders `llm-slash-commands` ahead of `llm-skills` when both are present, but do **not** call `consumeService`. Look up via `ctx.useService<SlashRegistryService>("slash:registry")` in `setup()` — succeeds when present, returns undefined when absent, no throw. Registration is skipped in the absent case. Document the choice with an inline comment next to the `services.consumes` entry, as the architecture doc requires.

## Command surface

### `/skills:list`

- **Args:** none.
- **Output (rendered as markdown via `cmdCtx.print(text, { markdown: true })`):**
  - One line per registered skill, alphabetically sorted by name.
  - Format: `` `<name>` — <description> ``
  - Empty-registry case: a single line "No skills registered."
- **Source layer is intentionally omitted** from this view. It belongs in `/skills:get` where the source path tells the full story.

### `/skills:get <name>`

- **Args:** required `<name>`. Match is exact (case-sensitive, just like the registry).
- **Output (markdown):**
  - Header block: name, source layer (project / user / programmatic), source path if disk-backed, token count.
  - Separator.
  - Skill body, rendered.
- **Missing arg:** print `Usage: /skills:get <name>` and a hint to run `/skills:list`.
- **Unknown name:** print `Unknown skill: <name>. Run /skills:list to see what's available.` No fuzzy match.

## Decisions

### Why no `/skills:use`

A user-initiated command that *only* hints at the LLM ("please use skill X") is structured prose with autocomplete. It overpromises in command framing while underdelivering mechanically. We get most of its value today via prose. If `/skills:list` reveals real demand for a guided invocation path, revisit then — informed by usage rather than speculation.

A deterministic `:use` (inject the body as a synthetic user message) was also considered. Rejected because it bypasses the existing `load_skill` contract and creates a second loading path with different semantics.

### Why colocate in `llm-skills`, not a new plugin

`llm-skills` already owns the registry, the `load_skill` tool, and the prompt section. Two read-only commands fit naturally as a thin TUI surface on top. A dedicated `llm-skills-commands` plugin would add a service hop (`useService<SkillsRegistryService>`) for no isolation benefit.

### Source layer in `list` vs `get`

Compact discoverability beats provenance in a list view. Provenance belongs in inspection. This mirrors the existing slash-command sort order (rank in `list`, full metadata on demand).

## Error handling

- Slash registration failure (e.g. duplicate registration on hot reload) bubbles up via the same `harness:error` path the rest of `llm-skills` uses. The plugin must still boot if registration fails — the `load_skill` tool and `prompt:registry` section are the load-bearing surface.
- `/skills:get` must not throw for any registry state. Token recomputation, body fetch, etc. all wrap in try/catch and degrade to a printed error rather than a thrown one.

## Testing

`test/slash-commands.test.ts` under `llm-skills`. Pattern matches the existing `dispatcher.test.ts` in `llm-slash-commands` — pass a fake `SlashRegistryService` and a fake `print`, assert on registered commands and rendered output.

Cases:
- List with empty registry → "No skills registered."
- List with multiple skills → alpha sort, name+description format.
- Get with no arg → usage hint.
- Get with unknown name → not-found hint.
- Get with known disk-backed skill → header includes source path + tokens, body follows.
- Get with programmatic skill → header omits source path (no file), still includes tokens.
- Unregister on teardown removes both commands from the fake registry.

Integration smoke test in `index.test.ts`: when the fake `ctx` provides `slash:registry`, the plugin registers; when it doesn't, the plugin still loads cleanly.

## Local deploy

Standard `llm-skills` deploy flow — see that plugin's `CLAUDE.md`. No new install-dir layout.
