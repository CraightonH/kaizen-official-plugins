# Working in `llm-skills`

Notes for agents editing this plugin. See `README.md` for the user-facing contract.

## Module map

```
index.ts          Plugin lifecycle: loads config from config:store, resolves roots,
                  builds registry, runs initial scan, provides skills:registry, registers
                  a prompt:registry section and subscribes to turn:start, registers
                  load_skill into tools:registry. The only file that touches `ctx`.
config.ts         DEFAULT_CONFIG (frozen) + CONFIG_SCHEMA for config:store. Pure.
registry.ts       makeRegistry({ projectRoot, userRoot, warn, error }) → SkillsRegistryServiceImpl.
                  Pure logic. Owns three layered maps (project / user / programmatic) and a
                  snapshot string for change detection. Conflict resolution lives here.
scan.ts           scanRoot(absRoot) → ScannedFile[]. Pure I/O. Walks a directory recursively,
                  skips dotfiles, follows symlinks (with realpath cycle guard), reads bodies,
                  derives names from relative paths. Returns sorted output.
frontmatter.ts    parseFrontmatter(text) → { ok, manifest, body } | { ok: false, error }.
                  Hand-rolled YAML-ish parser (no dependency). Recognises name, description,
                  tokens; rejects unknown keys silently; requires single-line values.
injection.ts      buildSkillsBlock(list). Pure string builder for the prompt:registry section
                  body. Returns "" when list is empty (the registry drops empty sections).
tool.ts           LOAD_SKILL_SCHEMA and makeLoadSkillHandler(registry, emit). Pure factory;
                  no state.
new-skill.ts      NEW_SKILL_SCHEMA, validateNewSkillInput, resolveTargetPath,
                  assertNoCollision, composeSkillFile, makeNewSkillHandler. Pure
                  factory + pure helpers; the handler is the only function that
                  touches the filesystem. Validates input, refuses on collision
                  (lstat — does not follow symlinks), writes SKILL.md via
                  write-then-rename, triggers a registry rescan, returns
                  { name, path, scope, tokens }.
tokens.ts         estimateTokens(body) → ceil(len / 4). One line; the heuristic.
public.d.ts       Owns SkillManifest, SkillRescanResult, SkillsRegistryService. These are
                  feature-owned by this plugin (skills:registry is a feature service, not a
                  llm-events foundation contract — see AGENTS.md). Other plugins should
                  import from `llm-skills/public`.
```

Boundaries:
- Only `index.ts` imports `kaizen/types` or touches `ctx`.
- `scan.ts` is one of two modules that does filesystem I/O (the other is
  `new-skill.ts`, which only writes).
- `registry.ts` is the only stateful module. Everything else is pure.
- Tests for each module live alongside in `test/` and run independently (`bun test`).

## Invariants

- **Path-derived name is canonical.** Frontmatter `name` is informational only — if it disagrees with the relative path, the path wins and a warning is logged. The LLM-visible identifier must be predictable from disk layout.
- **Project beats user beats programmatic.** Conflict resolution is fixed; do not reorder. Masking emits a `warn` (config-time concern), not an event.
- **Scan failures are non-fatal.** Bad frontmatter, unreadable files, duplicate names within a layer all skip the offending entry and emit `harness:error` (or `warn` for masking). The scan must never throw.
- **Empty registry → no section.** `buildSkillsBlock` returns `""` for an empty list; the `prompt:registry` service's "empty sections are dropped" invariant ensures no `## Available skills` header appears.
- **Skills contribute via `prompt:registry`.** A section with id `"llm-skills:available"` and priority 160 is registered at setup. Its title is "Available skills". Generation is bumped after any rescan-changed event and after programmatic register/unregister calls.
- **Tokens are cached at registration.** `manifest.tokens` is computed once (heuristic or frontmatter override) and never recomputed by `list()`. The `load_skill` handler recomputes only as a fallback when `list()` doesn't carry a token count for the loaded skill.
- **`load_skill` is registered late and unregistered on stop.** The `services.consumes: ["tools:registry"]` declaration is what guarantees topological ordering — without it, `useService("tools:registry")` may run before the registry is ready. The cleanup callback is held in a module-scope `let` and drained by `stop()`, which is idempotent.
- **Rescan throttling is wall-clock based.** `lastScanAt` is captured by the `turn:start` closure. If `config.rescanIntervalMs` is non-positive, fall back to the 30 s default at runtime. Never treat 0 as "always rescan". The schema permits `min: 0` so user values are not silently reverted by the store; the clamp lives in `index.ts`.
- **`new_skill` writes only SKILL.md.** Sibling files in the skill directory
  (`references/`, `scripts/`, anything else) are the user's concern. The tool
  refuses on collision via `lstat` so a partial scaffold the user is
  mid-authoring is not clobbered.

## Adding a programmatic skill from another plugin

```typescript
const skills = ctx.useService<SkillsRegistryService>("skills:registry");
const unregister = skills.register(
  { name: "my-plugin/my-skill", description: "What it does, single line.", tokens: 250 },
  async () => "skill body markdown",
);
// ...
unregister();
```

Programmatic entries sit at the lowest priority — a same-named file in either disk root will mask them. Use a namespaced name (`plugin-name/skill-name`) to avoid collisions with file-backed skills.

If your plugin needs to advertise a different system-prompt section, register your own section into `prompt:registry` (see the system-prompt plugin's contract). Do not extend `injection.ts`.

## Editing scan behavior

`scan.ts` is intentionally narrow: walk top-level subdirectories of each root,
read `<dir>/SKILL.md` only, derive name from the directory name. Cycles through
symlinks at the top level are accepted (the readFile will silently fail if the
target isn't a directory with a SKILL.md). Don't add a watcher (spec rules it
out — scan-on-turn-start is the model). Multi-file skill *writing* is owned by
the user (sibling files like `references/`, `scripts/` are left alone by the
scanner and never touched by `new_skill`).

## Editing the frontmatter parser

The parser is hand-rolled to avoid pulling in a YAML dep. It accepts a deliberately small subset:
- Only `name`, `description`, `tokens` keys are honored; unknown keys are silently ignored.
- Values are single-line; embedded newlines are an error.
- Quotes (single or double) are stripped if balanced.
- Closing delimiter may be either `\n---\n` or trailing `\n---`.

If a real YAML need arises (lists, nested objects, multi-line strings), pull in `js-yaml` rather than expanding this parser. The current shape is a feature, not a limitation.

## Testing

```bash
cd plugins/llm-skills && bun test
```

Tests use `bun:test` only. Filesystem fixtures for scan/registry tests live under `test/fixtures/`. The `index.test.ts` and `integration.test.ts` files use a fake `ctx` rather than spinning up a real Kaizen runtime.

When adding a new test that touches the disk, prefer creating a fixture directory under `test/fixtures/` and asserting against it; do not write to `~/.kaizen/skills/` from tests.

## Local deploy

The Kaizen runtime prefers the bundled `dist/index.js` over source. After editing, the plugin must be re-bundled into the install dir:

```bash
mkdir -p ~/.kaizen/marketplaces/official/plugins/llm-skills@0.1.2/
cp -R plugins/llm-skills/. ~/.kaizen/marketplaces/official/plugins/llm-skills@0.1.2/
(cd ~/.kaizen/marketplaces/official/plugins/llm-skills@0.1.2 \
  && bun build --target=bun --outfile=dist/index.js index.ts)
```

If you also need the harness manifest to pick up changes, sync the local marketplace repo (`~/.kaizen/marketplaces/official/repo/`) — it tracks upstream `main` and `kaizen marketplace update` will overwrite local edits.
