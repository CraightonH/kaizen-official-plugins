# claude-skills — Shim Claude Code skills into the local harness

**Status:** Draft for implementation
**Date:** 2026-05-22
**Owner:** chancock@taxhawk.com

## Goal

Make Claude Code's on-disk skills (user, project, and plugin-cache layouts) available to the `local` harness through the existing `skills:registry` service, so the openai-llm-driven loop has the same skill surface the CC binary natively provides in the `claude-wrapper` harness.

## Scope

In:

- A new plugin, `claude-skills`, that scans CC's three skill discovery roots, parses each `SKILL.md`, and registers it programmatically with `skills:registry`.
- A backwards-compatible extension to the `SkillManifest` contract: optional `baseDir?: string`.
- A small behavior addition inside `llm-skills`'s `load_skill` handler: when a manifest carries `baseDir`, prepend a one-line preamble to the returned body, matching CC's own format.

Out:

- Watching skill directories (rescan stays poll-on-`turn:start`, same as `llm-skills`).
- Multi-file CC skill semantics beyond reading `SKILL.md` (helper files, scripts, references are accessed by the LLM via existing filesystem tools, not surfaced through this plugin).
- Migrating `llm-skills`'s pre-existing `KAIZEN_LLM_SKILLS_RESCAN_MS` raw-env path to `config:store` (separate change).
- Changes to `harnesses/claude-wrapper.json` (the CC binary already exposes its own skills natively in that harness).

## Background

`llm-skills` (today) scans flat `.md` files under `<cwd>/.kaizen/skills/` and `~/.kaizen/skills/`, builds a `skills:registry`, advertises entries in the system prompt, and exposes a `load_skill` tool whose handler returns the body for the LLM to consume on the next turn.

CC's skill layout differs:

- User: `~/.claude/skills/<name>/SKILL.md`
- Project: `<cwd>/.claude/skills/<name>/SKILL.md`
- Plugin cache: `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/skills/<name>/SKILL.md`

CC bodies frequently reference sibling files (`references/foo.md`, `scripts/bar.py`) with paths relative to the skill's own directory. CC handles this by prepending a single line when it loads a skill:

```
Base directory for this skill: /abs/path/to/skill-dir

[skill body here]
```

The local harness's LLM has no implicit "current directory" tied to a skill, so without this preamble those relative references resolve against the wrong base (or, more often, not at all).

## Design overview

Three changes, two plugins extended and one created.

### 1. `llm-contracts` — extend `SkillManifest`

```typescript
interface SkillManifest {
  name: string;
  description: string;
  tokens?: number;
  baseDir?: string;   // NEW — absolute path to the skill's root directory
}
```

Backwards compatible: the field is optional, and missing means "no preamble" (existing file-backed skills are unaffected).

Bump `llm-contracts` minor version.

### 2. `llm-skills` — emit the preamble when `baseDir` is set

In the `load_skill` handler, after resolving the manifest:

```typescript
const body = await registry.load(name);
const manifest = registry.list().find((m) => m.name === name);
const prefix = manifest?.baseDir
  ? `Base directory for this skill: ${manifest.baseDir}\n\n`
  : "";
return { name, tokens, body: prefix + body };
```

Rationale for this living in `llm-skills`, not in `claude-skills`'s loader lambda:

- `load_skill` is the tool that returns this output. The format is part of *its* contract.
- A future programmatic-skills shim (against an internal skill repo, against a different IDE's format, etc.) gets correct behavior by setting one optional field rather than re-implementing the prefix string.
- See [Convention over diff minimization](../../../../.claude/projects/-Users-chancock-git-kaizen-official-plugins/memory/feedback_convention_over_diff_minimization.md) — convention belongs at its canonical owner.

The available-skills prompt section (`buildSkillsBlock`) is **not** modified — `baseDir` is a load-time concern, not a discovery-time one.

Bump `llm-skills` minor version.

### 3. `claude-skills` — new plugin

A pure consumer plugin that scans the three CC roots and feeds the registry.

## Plugin spec — `claude-skills`

### Manifest

```json
{
  "name": "claude-skills",
  "apiVersion": "3.0.0",
  "permissions": { "tier": "unscoped" },
  "services": { "consumes": ["skills:registry", "config:store"] }
}
```

Both consumed services are hard dependencies — without `skills:registry` the plugin has nothing to register against, and without `config:store` it can't read its throttle interval. Both declared via `services.consumes`, `consumeService(id)`, and `useService<T>(id)` (the contract for a hard runtime dependency per `docs/PLUGIN_ARCHITECTURE.md`).

`tier: unscoped` because the plugin reads under `~/.claude/` and `<cwd>/.claude/` — locations outside the scoped tiers' standard allowlists. No writes, no process execution, no network.

### Module map

```
index.ts          Plugin lifecycle. Resolves the three roots, registers a
                  config schema, consumes skills:registry, runs the initial
                  scan + registrations, subscribes to turn:start for the
                  throttled rescan loop, drains registrations on stop().
                  Only file that touches `ctx`.

scan.ts           scanRoots({ projectRoot, userRoot, pluginCacheRoot })
                  → ScannedSkill[]. Pure I/O. Walks the three layouts,
                  finds SKILL.md per <name>/ dir (and per
                  <plugin>/<ver>/skills/<name>/ for plugin cache), reads
                  body, derives display name per layer:
                    project / user → <name>
                    plugin cache   → <plugin>:<name>
                  Skips dotfiles. Follows symlinks with realpath cycle
                  guard. Within plugin-cache, dedupes per <plugin>:<name>
                  by lexicographically-highest version directory.

frontmatter.ts    parseFrontmatter(text) → { ok, manifest, body } |
                  { ok: false, error }. Hand-rolled parser; same shape as
                  llm-skills/frontmatter.ts. Honors `name`, `description`,
                  optional `tokens`; silently ignores all other keys
                  (including CC's `allowed-tools`).

registrar.ts     reconcile(registry, currentScan, previousSnapshot)
                  → newSnapshot. Pure logic. Diffs by name → contentHash.
                  Calls register / unregister for adds, removes, and
                  hash-changes. Returns the next snapshot map.

hash.ts          contentHash(body) → string. SHA-1 hex of body bytes.

public.d.ts      Empty (no contracts exported, no services provided).
```

Module boundaries:

- Only `index.ts` imports `kaizen/types` or touches `ctx`.
- `scan.ts` is the only module that performs filesystem I/O.
- `registrar.ts` is the only stateful module (holds the previous snapshot).
- `frontmatter.ts`, `hash.ts`, the body of `scan.ts`'s walkers, and `registrar.ts`'s reconcile function are pure.

### Configuration — `config:store` schema

```typescript
config.register("claude-skills", {
  fields: {
    rescanIntervalMs: {
      type: "number",
      default: 30000,
      envVars: ["KAIZEN_CLAUDE_SKILLS_RESCAN_MS"],
      description: "Throttle interval, in ms, for turn:start rescans of CC skill roots.",
    },
  },
});
```

Precedence (kaizen-config's standard order): env var > project file > home file > default. Invalid values (NaN, ≤ 0) fall back to default and log a warn.

Subscribe to `config:store` changes for the `claude-skills` namespace so the live interval updates without restart. Cheap and removes a footgun where the user updates the config file but doesn't see effect until next restart.

### Data flow — setup

```
plugin start
  → resolve roots
      projectRoot     = <ctx.cwd>/.claude/skills
      userRoot        = $HOME/.claude/skills           (honors $HOME from ctx.env then process.env)
      pluginCacheRoot = $HOME/.claude/plugins/cache
  → useService<ConfigStoreService>("config:store")
  → config.register("claude-skills", schema)
  → useService<SkillsRegistryService>("skills:registry")
  → scanRoots() → ScannedSkill[]
  → for each (plugin-cache first, then user, then project):
      registry.register(
        {
          name,
          description,
          tokens: explicit-from-frontmatter ?? heuristic(body.length),
          baseDir: absSkillDir,
        },
        async () => readFile(skillMdPath),
      )
      track unregister fn + contentHash by name
  → previousSnapshot = { name → { hash, unregister, scannedPath } }
  → ctx.on("turn:start", throttledRescan)
```

Registration order matters because `llm-skills`'s programmatic layer is single-shared: writers with the same name overwrite the prior loader. Plugin-cache first, then user, then project means project entries overwrite user entries which overwrite plugin-cache entries — matching the documented precedence (project > user > plugin-cache).

### Data flow — per turn (throttled rescan)

```
turn:start
  → if (now - lastScanAt < currentIntervalMs) return
  → lastScanAt = now
  → scanRoots() → currentScan
  → reconcile(registry, currentScan, previousSnapshot):
      for name in previous not in current:    unregister
      for name in current not in previous:    register
      for name in both, hash differs:         unregister + register
      for name in both, hash same:            no-op
  → previousSnapshot = newSnapshot
```

`currentIntervalMs` is held in a module-scope `let`, initialized from `config.get(...)` in setup, and updated by the `config:store` subscription callback. Changes take effect on the next `turn:start`.

### Data flow — `load_skill` (in `llm-skills`)

```
LLM calls: load_skill({ name: "superpowers:brainstorming" })
  → registry.load(name)                          // claude-skills's loader
  → reads SKILL.md, returns body string
  → llm-skills handler resolves manifest from registry.list()
  → if manifest.baseDir: body = `Base directory for this skill: ${baseDir}\n\n${body}`
  → returns { name, tokens, body }
  → tools:registry surfaces the body as a tool message on the next turn
```

### Data flow — stop

```
ctx.stop()
  → for each entry in previousSnapshot: try { unregister() } catch {}
  → previousSnapshot = {}
  → unsubscribe from config:store change callback
  → idempotent (re-stops are no-ops)
```

### Naming

- Project: directory basename — `<name>` (e.g., `my-skill`).
- User: directory basename — `<name>`.
- Plugin cache: `<plugin>:<name>` (e.g., `superpowers:brainstorming`). Matches the names CC itself surfaces in `<available-skills>`. The `<marketplace>` segment is not part of the public name.

### Conflict resolution

- **Cross-layer:** project > user > plugin-cache. Enforced by registration order against `skills:registry`'s programmatic layer (later writers replace earlier). Not an error; expected behavior. No warn.
- **Within plugin-cache, multiple versions of same plugin** (`superpowers/5.0.0` and `superpowers/5.1.0`): keep lexicographically-highest version. Older versions logged via `ctx.log`. Not an error.
- **Within the same layer, true duplicates** (shouldn't happen for filesystem layouts): register the first, skip the rest, emit `harness:error` naming both paths.

### Token counts

Same precedence as `llm-skills`:

1. If `tokens:` appears in the frontmatter, honor it.
2. Otherwise, `Math.ceil(body.length / 4)`.

Computed once at registration. `load_skill`'s fallback recomputation in `llm-skills` is unchanged.

## Error handling

### Scan errors (per-skill, non-fatal)

| Condition | Behavior |
|---|---|
| `<name>/` dir contains no `SKILL.md` | Skip silently |
| `SKILL.md` unreadable (EACCES, EIO) | Skip + `harness:error` with path and errno |
| Frontmatter parse failure | Skip + `harness:error` with path and parse error |
| Frontmatter missing required `name` or `description` | Skip + `harness:error` |
| Symlink cycle | Realpath-set guard skips silently |
| Bad `tokens:` value (NaN, negative) | Fall back to heuristic, log warn |

`scan.ts` never throws. One bad skill never blocks the others.

### Registration errors

- **Same-layer duplicate** → first wins, rest skipped, `harness:error` emitted naming both paths.
- **Cross-layer mask** → not an error (documented precedence). No warn.
- **Version dedup** → `ctx.log` line listing skipped older versions.

### Service errors

- `skills:registry` absent at boot → `consumeService` causes the harness to refuse to start the plugin. Correct behavior — claude-skills has zero value without it.
- `config:store` absent at boot → same.

### Load-time errors (in the loader lambda)

- SKILL.md disappeared or became unreadable between scan and load → loader throws with a clear message; `llm-skills`'s `load_skill` handler surfaces it via `tool:error`. The stale registration is cleaned up on the next rescan.

### Rescan errors

- Any uncaught error inside the throttled rescan callback → caught, emitted as `harness:error`, `lastScanAt` still advances (so we don't busy-loop on a broken scan), `previousSnapshot` left intact (no partial reconciliation).

### Stop()

- All unregister calls wrapped in `try/catch`. Idempotent.

### Inside `llm-skills`'s extended `load_skill` handler

- `manifest.baseDir` missing → no prefix prepended (back-compat).
- `manifest.baseDir === ""` → treated as unset.
- `baseDir` is trusted as-is (claude-skills resolves to absolute before setting). No re-validation in llm-skills.

## Testing

### `llm-contracts`

Type-only change. No runtime tests. Downstream suites exercise it.

### `llm-skills` (additions)

In the existing test file for the `load_skill` handler:

- Returns body unchanged when `manifest.baseDir` is unset.
- Returns `Base directory for this skill: <dir>\n\n<body>` when `manifest.baseDir` is set.
- Empty string `baseDir` (`""`) is treated as unset (no prefix).
- Asserts the exact prefix line (regression guard against silent format drift from CC's behavior).

### `claude-skills` (new)

```
test/
  scan.test.ts          Fixture-driven. Fake roots on disk under
                        test/fixtures/three-roots/. Covers: name derivation
                        per layer, baseDir absoluteness, dir-without-SKILL.md
                        skipped, bad frontmatter collected (not thrown),
                        missing required fields, symlink cycle guarded,
                        multiple cached versions resolved to highest.

  frontmatter.test.ts   Happy path, missing required fields, unknown keys
                        ignored (including allowed-tools), trailing/leading
                        whitespace, unclosed delimiter, embedded-newline value.

  registrar.test.ts     reconcile() with a fake registry recording calls:
                        first pass registers all; same input → no calls;
                        removed name → unregister; added name → register;
                        hash change → unregister + register.

  hash.test.ts          Same input → same hash; different input → different.

  index.test.ts         Fake ctx. Asserts:
                        - services.consumes includes both services
                        - config.register called with the schema
                        - initial scan registered N skills
                        - turn:start subscribed
                        - turn:start within throttle: no-op
                        - turn:start past throttle: reconcile invoked
                        - config change to rescanIntervalMs: honored next tick
                        - stop(): all unregister fns invoked, idempotent
                        - missing skills:registry: setup throws (hard dep)
                        - missing config:store: setup throws (hard dep)
```

Fixture layout under `plugins/claude-skills/test/fixtures/`:

```
three-roots/
  project/.claude/skills/proj-only/SKILL.md
  project/.claude/skills/shared/SKILL.md           ← masks user/cache
  user/.claude/skills/user-only/SKILL.md
  user/.claude/skills/shared/SKILL.md              ← masked by project
  cache/mp1/plug-a/1.0.0/skills/cached-a/SKILL.md
  cache/mp1/plug-a/2.0.0/skills/cached-a/SKILL.md  ← wins over 1.0.0
  cache/mp1/plug-b/1.0.0/skills/cached-b/SKILL.md

bad-frontmatter/
  user/.claude/skills/broken/SKILL.md              ← unclosed `---`

missing-fields/
  user/.claude/skills/no-desc/SKILL.md             ← name only
```

No integration test against a real Kaizen runtime — fake ctx is sufficient, matching `llm-skills`'s convention.

### Harness validation

`kaizen plugin validate plugins/claude-skills` must pass.

## Harness wiring

Add to `harnesses/local.json`, after `llm-skills`:

```jsonc
{
  "plugins": [
    "...",
    "official/llm-skills@<next>",
    "official/claude-skills@0.1.0",
    "..."
  ]
}
```

Not added to `harnesses/claude-wrapper.json` — the CC binary handles its own skills there.

## Versioning

- `llm-contracts` — minor bump (additive field on `SkillManifest`).
- `llm-skills` — minor bump (new `baseDir`-handling behavior, back-compat).
- `claude-skills` — new at `0.1.0`.

Each plugin's version bump entails a `bun build --target=bun --outfile=dist/index.js index.ts` and the local-deploy procedure documented in each plugin's CLAUDE.md.

## Open questions

None at spec time. Resolve any that surface during planning into amendments to this doc rather than ad-hoc decisions during implementation.

## Acid test

> Remove `claude-skills`. The `local` harness boots; `llm-skills` still works for file-backed `.kaizen/skills/` entries; nothing in any other plugin needed to change.

> Remove `llm-skills`. `claude-skills` fails to boot (hard dep on `skills:registry`). Correct.

> Replace `llm-skills` with a stub that provides `skills:registry`. `claude-skills` boots, registers entries, and the available-skills section appears. `load_skill` calls succeed but no longer include the `Base directory for this skill:` preamble (because the stub doesn't implement it). This is acceptable — the preamble is part of `llm-skills`'s value-add for this contract, not a contractual guarantee of `skills:registry` itself.
