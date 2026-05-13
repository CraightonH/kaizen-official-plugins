# Working in `llm-skills`

Notes for agents editing this plugin. See `README.md` for the user-facing contract.

## Module map

```
index.ts          Plugin lifecycle: resolves roots, builds registry, runs initial scan,
                  provides skills:registry, registers a prompt:system section and subscribes
                  to turn:start, registers load_skill into tools:registry. The only file that
                  touches `ctx`.
registry.ts       makeRegistry({ projectRoot, userRoot, warn, error }) → SkillsRegistryServiceImpl.
                  Pure logic. Owns three layered maps (project / user / programmatic) and a
                  snapshot string for change detection. Conflict resolution lives here.
scan.ts           scanRoot(absRoot) → ScannedFile[]. Pure I/O. Walks a directory recursively,
                  skips dotfiles, follows symlinks (with realpath cycle guard), reads bodies,
                  derives names from relative paths. Returns sorted output.
frontmatter.ts    parseFrontmatter(text) → { ok, manifest, body } | { ok: false, error }.
                  Hand-rolled YAML-ish parser (no dependency). Recognises name, description,
                  tokens; rejects unknown keys silently; requires single-line values.
injection.ts      buildSkillsBlock(list). Pure string builder for the prompt:system section
                  body. Returns "" when list is empty (the registry drops empty sections).
tool.ts           LOAD_SKILL_SCHEMA and makeLoadSkillHandler(registry, emit). Pure factory;
                  no state.
tokens.ts         estimateTokens(body) → ceil(len / 4). One line; the heuristic.
public.d.ts       Owns SkillManifest, SkillRescanResult, SkillsRegistryService. These are
                  feature-owned by this plugin (skills:registry is a feature service, not a
                  llm-events foundation contract — see AGENTS.md). Other plugins should
                  import from `llm-skills/public`.
```

Boundaries:
- Only `index.ts` imports `kaizen/types` or touches `ctx`.
- `scan.ts` is the only module that does filesystem I/O.
- `registry.ts` is the only stateful module. Everything else is pure.
- Tests for each module live alongside in `test/` and run independently (`bun test`).

## Invariants

- **Path-derived name is canonical.** Frontmatter `name` is informational only — if it disagrees with the relative path, the path wins and a warning is logged. The LLM-visible identifier must be predictable from disk layout.
- **Project beats user beats programmatic.** Conflict resolution is fixed; do not reorder. Masking emits a `warn` (config-time concern), not an event.
- **Scan failures are non-fatal.** Bad frontmatter, unreadable files, duplicate names within a layer all skip the offending entry and emit `harness:error` (or `warn` for masking). The scan must never throw.
- **Empty registry → no section.** `buildSkillsBlock` returns `""` for an empty list; the `prompt:system` registry's "empty sections are dropped" invariant ensures no `## Available skills` header appears.
- **Skills contribute via `prompt:system`.** A section with id `"llm-skills:available"` and priority 160 is registered at setup. Its title is "Available skills". Generation is bumped after any rescan-changed event and after programmatic register/unregister calls.
- **Tokens are cached at registration.** `manifest.tokens` is computed once (heuristic or frontmatter override) and never recomputed by `list()`. The `load_skill` handler recomputes only as a fallback when `list()` doesn't carry a token count for the loaded skill.
- **`load_skill` is registered late and unregistered on stop.** The `services.consumes: ["tools:registry"]` declaration is what guarantees topological ordering — without it, `useService("tools:registry")` may run before the registry is ready. The cleanup callback is held in a module-scope `let` and drained by `stop()`, which is idempotent.
- **Rescan throttling is wall-clock based.** `lastScanAt` is captured by the `turn:start` closure. If `KAIZEN_LLM_SKILLS_RESCAN_MS` is invalid or non-positive, fall back to the 30 s default. Never treat 0 as "always rescan".

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

If your plugin needs to advertise a different system-prompt section, register your own section into `prompt:system` (see the system-prompt plugin's contract). Do not extend `injection.ts`.

## Editing scan behavior

`scan.ts` is intentionally narrow: walk directory, skip dotfiles, read `.md` bodies, derive names. Cycles through symlinks are guarded best-effort by a `Set` of visited paths. Don't add a watcher (spec rules it out — scan-on-turn-start is the model). Don't add multi-file skill support (`SKILL.md` + siblings) without a spec amendment.

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
