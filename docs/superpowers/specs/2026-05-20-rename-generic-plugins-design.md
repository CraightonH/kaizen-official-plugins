# Rename generic plugins/harness to project-native names

**Issue:** [#15 — Refactor plugin/harness names](https://github.com/CraightonH/kaizen-official-plugins/issues/15)
**Date:** 2026-05-20

## Goal

Rename plugins/harnesses whose surface area is generic enough that another
(non-LLM) harness could reasonably consume them, dropping the `llm-*` prefix in
favor of `kaizen-*` to signal "project-native infrastructure, not LLM-specific."
Rename the `openai-compatible` harness to a shorter name that contrasts cleanly
with `claude-wrapper`.

## Scope decision

The original issue suggested a broader sweep ("identify generic plugins, rename
to `kaizen-*`"). Inventory of all 27 plugins against the test *"could a
reasonable non-LLM harness use this plugin unchanged?"* yielded a tight set:

- **`llm-config` → `kaizen-config`** — pure harness-scoped KV store with a
  `/config` slash UI. Only LLM touchpoint is importing two contract type names
  (`ConfigStoreService`, `SlashRegistryService`) from `llm-contracts/public`,
  both of which are themselves generic.
- **`openai-compatible` harness → `local` harness** — issue's suggested name.
  Pairs cleanly against `claude-wrapper` (one runs the loop in-process; the
  other wraps an external CLI).

Plugins considered and **rejected for rename in this pass**:

| Plugin | Why kept as `llm-*` |
|---|---|
| `llm-contracts` | 18 of 19 contracts it declares are LLM-shaped (`llm:complete`, `prompt:registry`, `driver`, `dispatch`, `agents`, `axioms`, `memory`, `mcp-bridge`, all `ui:*`, etc.). The plugin is "the LLM contracts plugin," not "the contracts pattern plugin." |
| `llm-hooks-shell` | *Mechanism* is generic, but `MUTABLE_EVENTS` is a hardcoded set of LLM event names (`llm:before-call`, `tool:before-execute`, `codemode:before-execute`) and the file imports `CANCEL_TOOL`/`CODEMODE_CANCEL_SENTINEL` from `llm-events`. To rename honestly, mutability metadata must move into the events vocabulary contract first. Out of scope for this pass. |
| `llm-events` | Vocabulary is LLM event names; also exports provider service-def helpers. |
| All other `llm-*` | Each carries LLM-shaped concepts (prompts, turns, tools, completions, agents, sessions, TUI for chat). |

A registry-split refactor (e.g. `kaizen-axioms-registry` + `llm-axioms`) was
considered and explicitly rejected — `axioms:registry`, `agents:registry`, and
`skills:registry` each have exactly one producer today. Splitting single-
producer registries from their single producer is ceremony without benefit.
Revisit when a second producer for any of those registries materializes.

## Changes

### 1. `llm-config` → `kaizen-config`

Directory rename + package rename + all references updated.

**File system:**
- `git mv plugins/llm-config plugins/kaizen-config`
- Rebuild `dist/index.js` under the new directory name after content edits.

**Package metadata:**
- `plugins/kaizen-config/package.json`: `"name": "kaizen-config"`. Keep version
  `0.1.0` — name change is itself the breaking signal; no consumers outside
  this repo.
- `.kaizen/marketplace.json`: rename entry `llm-config` → `kaizen-config`,
  update `source.path` to `plugins/kaizen-config`.

**Dependency declarations** (workspace deps via `bun`):
- `plugins/llm-agents/package.json`
- `plugins/llm-codemode/package.json`
- `plugins/llm-hooks-shell/package.json`
- `plugins/llm-mcp-bridge/package.json`
- `plugins/llm-memory/package.json`
- `plugins/llm-session-manager/package.json`
- `plugins/llm-tavily-search/package.json`
- `plugins/llm-tool-approval/package.json`
- `plugins/openai-llm/package.json`
- Any others surfaced by `grep -rln '"llm-config"' plugins/*/package.json`.

**Harness manifest:**
- `harnesses/openai-compatible.json` (renamed to `local.json` per §2): plugin
  list entry `llm-config` → `kaizen-config`.

**Log/identity strings inside `kaizen-config`** itself:
- `index.ts` line 83 logs `"llm-config: slash:registry unavailable …"` —
  update prefix to `kaizen-config`.

**Tests inside `kaizen-config`:**
- `index.test.ts` reads `harnesses/openai-compatible.json` to compare version
  pins; update to the new harness filename (`local.json` per §2).
- `test/paths.test.ts` and `index.test.ts` use string literals like
  `"official/openai-compatible@0.1.0"` and `"openai-compatible"` — these are
  testing the harness-key derivation logic and must be updated to the new
  harness name (`"local"`, `"official/local@0.1.0"`).

**Documentation:**
- `docs/PLUGIN_ARCHITECTURE.md` — any references to `llm-config`.
- `plugins/kaizen-config/CLAUDE.md` and `README.md` — self-references.
- Repo root `README.md` — plugin listing.
- Repo root `CLAUDE.md` — no direct `llm-config` reference today; verify.

### 2. `openai-compatible` harness → `local` harness

**File system:**
- `git mv harnesses/openai-compatible.json harnesses/local.json`

**Manifest contents** (`harnesses/local.json`):
- `"name": "local"`
- Description stays accurate ("OpenAI-compatible LLM harness…") — the harness
  still talks to OpenAI-compatible endpoints; the name change is about the
  harness's role in the kaizen ecosystem, not what it connects to.

**Marketplace catalog** (`.kaizen/marketplace.json`):
- Entry `name`: `openai-compatible` → `local`.
- Entry `version.path`: `harnesses/openai-compatible.json` → `harnesses/local.json`.

**`harnessKey` derivation** — the user-visible breaking change.

`harnessKey({ jsonPath: ".../harnesses/<file>.json" })` returns
`"local_<basename>"`; `harnessKey({ ref: "official/<name>@<version>" })`
returns `"official_<name>"`. The basename and ref both change with this
rename:

- Old local key: `local_openai-compatible` → new: `local_local`
- Old marketplace key: `official_openai-compatible` → new: `official_local`

These keys are the on-disk path components for:
- `~/.kaizen/harnesses/<key>/config.json` (the harness-scoped config store)
- `~/.kaizen/harnesses/<key>/sessions/…` (session manager)
- Project-scoped equivalents under `<project>/.kaizen/harnesses/<key>/…`

**Migration strategy:** accept the break. Config has sensible defaults and
will be rebuilt on first run. Sessions are per-conversation and not
load-bearing across rebrands. The user (sole consumer of this repo) can
optionally `mv` the old directories to the new key before first launch to
preserve them:

```sh
mv ~/.kaizen/harnesses/local_openai-compatible \
   ~/.kaizen/harnesses/local_local
# and the marketplace-installed equivalent if applicable
mv ~/.kaizen/harnesses/official_openai-compatible \
   ~/.kaizen/harnesses/official_local
```

The spec does **not** add automatic migration code — that's complexity for a
one-time, one-user rename.

**Identity / display string:**
- `plugins/llm-system-prompt/identity.ts`: hardcoded
  `"You are a helpful assistant running locally via the kaizen openai-compatible harness."`
  → update to `"You are a helpful assistant running locally via the kaizen local harness."` (or similar — adjust wording to read naturally).

**Local-run command** (`CLAUDE.md`):
```diff
-kaizen --harness ./harnesses/openai-compatible.json
+kaizen --harness ./harnesses/local.json
```

**Documentation / READMEs:**
- `docs/PLUGIN_ARCHITECTURE.md` — references to "openai-compatible harness."
- Every plugin README/CLAUDE.md that says "for the openai-compatible harness"
  → "for the local harness" (`llm-tool-approval/README.md`,
  `llm-driver/README.md`, `llm-axioms/README.md`, `llm-memory/README.md`,
  `llm-environment/README.md`, `llm-events/README.md`, `llm-contracts/README.md`,
  `llm-contracts/CLAUDE.md`, `llm-native-dispatch/CLAUDE.md`,
  `llm-session-manager/README.md`, `llm-tavily-search/CLAUDE.md`,
  `openai-llm/README.md`, repo `README.md`).
- Archived spec/plan docs under `docs/superpowers/archive/` — leave as-is
  (historical record).

**Tests:**
- `plugins/llm-config/index.test.ts` and others read the harness JSON by name
  or reference `"openai-compatible"` as the harness identity literal — update.
- `plugins/llm-session-manager/test/harness-key.test.ts`,
  `test/paths.test.ts` — update expected key strings.
- `plugins/llm-tool-approval/test/*.test.ts`,
  `plugins/llm-events/index.test.ts`,
  `plugins/llm-hooks-shell/test/index.test.ts` — audit for harness-name
  literals.

### 3. Things that intentionally do NOT change

- `llm-contracts` — name stays, contracts stay (the 18-of-19-LLM-shaped
  finding above).
- `llm-hooks-shell` — name stays until `MUTABLE_EVENTS` is pushed into the
  vocabulary contract.
- All other `llm-*` plugin names.
- Contract IDs (`config:store`, `slash:registry`, etc.) — these are
  `<domain>:<role>`, never plugin-prefixed; the rule from
  `docs/PLUGIN_ARCHITECTURE.md` keeps them stable across plugin renames.
- Version numbers — name change is the breaking signal.
- Service implementations and contract types — pure rename, no behavioral
  changes.

## Verification

Run after the rename is mechanically complete:

```sh
bun install                                       # workspace dep resolution
bun test                                          # all plugin tests pass
kaizen plugin validate plugins/kaizen-config      # validator clean
kaizen --harness ./harnesses/local.json           # harness boots, /config works
```

Quick sanity greps that should return zero hits in non-archive paths:

```sh
grep -rn '"llm-config"' plugins/ harnesses/ .kaizen/ docs/ 2>/dev/null \
  | grep -v archive/
grep -rn 'harnesses/openai-compatible' plugins/ harnesses/ .kaizen/ docs/ *.md 2>/dev/null \
  | grep -v archive/
```

Bundle rebuild for the renamed plugin (per repo `CLAUDE.md` local-deploy notes):

```sh
cd plugins/kaizen-config
bun build --target=bun --outfile=dist/index.js index.ts
```

## Risks & rollback

- **Risk:** consumers (workspace deps in other plugins) miss a rename and
  fail `bun install`. *Mitigation:* exhaustive `grep -rln '"llm-config"'`
  pre-commit; `bun install` is the fast-fail check.
- **Risk:** runtime breaks because `harnessKey` derives a new on-disk path
  and the user's existing config doesn't migrate. *Mitigation:* documented
  manual `mv` above; otherwise harness falls back to defaults.
- **Rollback:** single commit. `git revert <sha>` returns the repo to the
  prior state. No external publication, no marketplace consumers outside
  this repo.

## Out of scope

- The `MUTABLE_EVENTS` refactor inside `llm-hooks-shell` (would unblock a
  future `kaizen-hooks-shell` rename).
- Registry-split refactor for `llm-axioms` / `llm-agents` / `llm-skills`.
- Bumping marketplace versions to signal the break — name change suffices
  for this repo's commits-to-main workflow.
