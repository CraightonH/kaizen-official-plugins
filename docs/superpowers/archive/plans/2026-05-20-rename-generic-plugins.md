# Rename generic plugins/harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename `llm-config` to `kaizen-config` and `openai-compatible` harness to `local`. Pure refactor — no behavioral changes.

**Architecture:** Two atomic refactors, each in a single commit. Each commit must keep the repo green (`bun install`, `bun test`, `kaizen plugin validate`). Plugin and harness names flow into workspace deps, harness manifest entries, marketplace catalog, on-disk `harnessKey` paths, test fixtures, and docs. Update all references in lock-step within each task.

**Tech Stack:** Bun workspace monorepo, kaizen plugin runtime (pulled in as dev dep), bun test, kaizen CLI validator.

**Spec:** `docs/superpowers/specs/2026-05-20-rename-generic-plugins-design.md` (commit `55ff5fb`).

---

## Pre-flight

Before starting, verify a clean baseline. The renames will produce a large diff; you want to know any failures are caused by your changes, not pre-existing breakage.

- [ ] **Step 0.1: Confirm clean tree**

Run: `git status`
Expected: working tree clean on branch `main`.

- [ ] **Step 0.2: Baseline `bun install`**

Run: `bun install`
Expected: completes without errors. (If it fails, stop — fix the baseline before touching anything.)

- [ ] **Step 0.3: Baseline `bun test`**

Run: `bun test`
Expected: all plugin tests pass. Note failing tests if any (they need to still fail the same way after — not new failures).

---

## Task 1: Rename `llm-config` → `kaizen-config`

**Files:**
- Rename: `plugins/llm-config/` → `plugins/kaizen-config/`
- Modify: `plugins/kaizen-config/package.json` (name field)
- Modify: `plugins/kaizen-config/index.ts` (log prefix)
- Modify: `.kaizen/marketplace.json` (entry name + source.path)
- Modify: `harnesses/openai-compatible.json` (plugin reference)
- Modify: 9 consumer `package.json` files (workspace dep names)
- Modify: `docs/PLUGIN_ARCHITECTURE.md`, `README.md` (any `llm-config` references)
- Rebuild: `plugins/kaizen-config/dist/index.js`

### Step 1.1: Rename the plugin directory

- [ ] **Step 1.1.1: Move the directory with git mv**

Run:
```sh
git mv plugins/llm-config plugins/kaizen-config
```
Expected: directory renamed, all files staged as renames.

Verify:
```sh
git status --short | head -20
```
Expected: lines starting with `R` (renames), e.g. `R  plugins/llm-config/index.ts -> plugins/kaizen-config/index.ts`.

### Step 1.2: Update the plugin's own `package.json`

- [ ] **Step 1.2.1: Rename the package**

Edit `plugins/kaizen-config/package.json`. Change line:
```json
  "name": "llm-config",
```
to:
```json
  "name": "kaizen-config",
```

Leave `"version": "0.1.0"` unchanged (per spec — name change is the breaking signal).

### Step 1.3: Update the plugin's internal log prefix

The plugin logs its name when a service it tries to consume is unavailable.

- [ ] **Step 1.3.1: Find and update the log line**

Read `plugins/kaizen-config/index.ts` around line 83. Find:
```ts
      ctx.log(`llm-config: slash:registry unavailable (${(err as Error).message}); /config commands disabled`);
```

Replace `llm-config:` with `kaizen-config:`:
```ts
      ctx.log(`kaizen-config: slash:registry unavailable (${(err as Error).message}); /config commands disabled`);
```

- [ ] **Step 1.3.2: Sanity-grep for any other internal `llm-config` references**

Run:
```sh
grep -n "llm-config" plugins/kaizen-config/*.ts plugins/kaizen-config/test/*.ts
```
Expected: zero hits in production source. Tests may have `llm-config` in fixtures — leave those alone for now if they exist (you'll catch them in 1.7).

### Step 1.4: Update workspace consumers

Nine plugins depend on `llm-config` via `"workspace:*"`. Update each.

- [ ] **Step 1.4.1: Update `plugins/llm-agents/package.json`**

Find line:
```json
    "llm-config": "workspace:*",
```
Replace with:
```json
    "kaizen-config": "workspace:*",
```

- [ ] **Step 1.4.2: Repeat for each consumer**

Apply the same change to:
- `plugins/llm-codemode/package.json`
- `plugins/llm-hooks-shell/package.json`
- `plugins/llm-mcp-bridge/package.json`
- `plugins/llm-memory/package.json`
- `plugins/llm-session-manager/package.json`
- `plugins/llm-tavily-search/package.json`
- `plugins/llm-tool-approval/package.json`
- `plugins/openai-llm/package.json`

- [ ] **Step 1.4.3: Verify no stragglers**

Run:
```sh
grep -rn '"llm-config"' plugins/*/package.json
```
Expected: zero hits.

### Step 1.5: Update the marketplace catalog

- [ ] **Step 1.5.1: Rename the entry in `.kaizen/marketplace.json`**

Find the entry:
```json
    {
      "kind": "plugin",
      "name": "llm-config",
      "description": "Harness-scoped plugin configuration store. Provides config:store.",
      "categories": ["foundation", "config"],
      "versions": [
        { "version": "0.1.0", "source": { "type": "file", "path": "plugins/llm-config" } }
      ]
    },
```

Replace with:
```json
    {
      "kind": "plugin",
      "name": "kaizen-config",
      "description": "Harness-scoped plugin configuration store. Provides config:store.",
      "categories": ["foundation", "config"],
      "versions": [
        { "version": "0.1.0", "source": { "type": "file", "path": "plugins/kaizen-config" } }
      ]
    },
```

### Step 1.6: Update the harness manifest

- [ ] **Step 1.6.1: Update `harnesses/openai-compatible.json`**

Find line:
```json
    "official/llm-config@0.1.0",
```
Replace with:
```json
    "official/kaizen-config@0.1.0",
```

(The harness file itself gets renamed in Task 2 — leave the filename alone for now.)

### Step 1.7: Update test fixtures inside `kaizen-config`

The plugin's own tests reference its name in expected log output and (possibly) other literals.

- [ ] **Step 1.7.1: Audit test files**

Run:
```sh
grep -n "llm-config" plugins/kaizen-config/test/*.ts plugins/kaizen-config/*.test.ts
```

For each hit:
- If it's an expected log-output string like `"llm-config: slash:registry unavailable …"`, change to `"kaizen-config: …"`.
- If it's a path literal referencing `plugins/llm-config/...` from the test's perspective, change to `plugins/kaizen-config/...`.
- If it's a `harnesses/openai-compatible.json` reference, leave alone (Task 2 handles harness rename).
- If it's `"openai-compatible"` as a harness-id literal, leave alone (Task 2).

### Step 1.8: Update docs

- [ ] **Step 1.8.1: Repo `README.md`**

Run:
```sh
grep -n "llm-config" README.md
```
For each hit, replace with `kaizen-config`. (The repo README lists every plugin with a one-line purpose — update the bullet.)

- [ ] **Step 1.8.2: `docs/PLUGIN_ARCHITECTURE.md`**

Run:
```sh
grep -n "llm-config" docs/PLUGIN_ARCHITECTURE.md
```
For each non-historical hit, replace with `kaizen-config`. If a passage discusses the plugin in context of the contracts pattern or the config-store contract, the name update is sufficient — no narrative rewrite needed.

- [ ] **Step 1.8.3: Plugin's own `CLAUDE.md` and `README.md`**

Files: `plugins/kaizen-config/CLAUDE.md`, `plugins/kaizen-config/README.md`.

For each, run `grep -n "llm-config"` and replace self-references with `kaizen-config`.

- [ ] **Step 1.8.4: Archive — leave untouched**

Do NOT modify `docs/superpowers/archive/**` — those are historical records.

Confirm with:
```sh
grep -rln "llm-config" docs/ | grep archive/
```
Expected: archive paths are listed (and stay untouched).

### Step 1.9: Rebuild the bundle

The kaizen runtime prefers `dist/index.js` over source (per repo `CLAUDE.md`).

- [ ] **Step 1.9.1: Build**

Run:
```sh
cd plugins/kaizen-config && bun build --target=bun --outfile=dist/index.js index.ts && cd ../..
```
Expected: build succeeds, `plugins/kaizen-config/dist/index.js` is updated.

### Step 1.10: Reinstall workspace and verify

- [ ] **Step 1.10.1: Reinstall**

Run:
```sh
bun install
```
Expected: resolves the new `kaizen-config` workspace name across all 9 consumers. No errors.

- [ ] **Step 1.10.2: Run all tests**

Run:
```sh
bun test
```
Expected: same pass/fail set as baseline (Step 0.3). No new failures.

If you see a new failure mentioning `llm-config` or a workspace resolution error, the most likely cause is a missed `package.json` consumer or a fixture string. Re-check Step 1.4 and Step 1.7.

- [ ] **Step 1.10.3: Validate the renamed plugin**

Run:
```sh
kaizen plugin validate plugins/kaizen-config
```
Expected: validator passes.

- [ ] **Step 1.10.4: Final straggler grep**

Run:
```sh
grep -rn '"llm-config"\|llm-config@\|plugins/llm-config' \
  plugins/ harnesses/ .kaizen/ docs/ README.md CLAUDE.md 2>/dev/null \
  | grep -v archive/ \
  | grep -v node_modules
```
Expected: zero hits.

### Step 1.11: Commit

- [ ] **Step 1.11.1: Stage and commit**

Run:
```sh
git add -A
git status
```
Verify the diff includes:
- The directory rename (R lines for every file under `plugins/llm-config` → `plugins/kaizen-config`)
- 9 consumer `package.json` edits
- `.kaizen/marketplace.json` edit
- `harnesses/openai-compatible.json` edit
- Doc edits (`README.md`, `docs/PLUGIN_ARCHITECTURE.md`, plugin's own `CLAUDE.md`/`README.md`)
- Rebuilt `plugins/kaizen-config/dist/index.js`
- Updated `bun.lock` (if present)

Commit:
```sh
git commit -m "rename: llm-config -> kaizen-config

Generic harness-scoped config store; no LLM concepts in its surface
area. See docs/superpowers/specs/2026-05-20-rename-generic-plugins-design.md."
```

No `Co-Authored-By` line (per repo `CLAUDE.md`).

---

## Task 2: Rename `openai-compatible` harness → `local`

**Files:**
- Rename: `harnesses/openai-compatible.json` → `harnesses/local.json`
- Modify: `.kaizen/marketplace.json` (harness entry name + path)
- Modify: `plugins/llm-system-prompt/identity.ts` (display string)
- Modify: `CLAUDE.md` (run command)
- Modify: ~13 plugin README/CLAUDE.md files (harness name in prose)
- Modify: `docs/PLUGIN_ARCHITECTURE.md`
- Modify: `README.md` (root)
- Modify: test fixtures across multiple plugins (harness-key tests, identity test, etc.)

### Step 2.1: Rename the harness file

- [ ] **Step 2.1.1: git mv**

Run:
```sh
git mv harnesses/openai-compatible.json harnesses/local.json
```

### Step 2.2: Update the marketplace catalog

- [ ] **Step 2.2.1: Update the harness entry in `.kaizen/marketplace.json`**

Find:
```json
    {
      "kind": "harness",
      "name": "openai-compatible",
      "description": "OpenAI-compatible LLM harness: chat against any OpenAI-compatible endpoint (LM Studio, Ollama, vLLM, etc.).",
      "categories": ["harness", "llm", "openai"],
      "versions": [{ "version": "0.1.0", "path": "harnesses/openai-compatible.json" }]
    }
```

Replace with:
```json
    {
      "kind": "harness",
      "name": "local",
      "description": "Local LLM harness: in-process chat loop against any OpenAI-compatible endpoint (LM Studio, Ollama, vLLM, etc.).",
      "categories": ["harness", "llm", "local"],
      "versions": [{ "version": "0.1.0", "path": "harnesses/local.json" }]
    }
```

(Description tweak makes "local" make sense at the marketplace level. Category list dropped `openai` to avoid implying the harness is OpenAI-specific, and added `local`.)

### Step 2.3: Update the system-prompt identity string

The LLM sees this string in its system prompt and should reflect the new harness name.

- [ ] **Step 2.3.1: Edit `plugins/llm-system-prompt/identity.ts`**

Find:
```ts
  "You are a helpful assistant running locally via the kaizen openai-compatible harness.";
```

Replace with:
```ts
  "You are a helpful assistant running locally via the kaizen local harness.";
```

Note: if the file uses a different exact phrasing (verify by reading), preserve surrounding context and just swap the harness name token.

### Step 2.4: Update the run command in repo `CLAUDE.md`

- [ ] **Step 2.4.1: Edit `CLAUDE.md`**

Find:
```sh
kaizen --harness ./harnesses/openai-compatible.json
```
Replace with:
```sh
kaizen --harness ./harnesses/local.json
```

Also scan the file for any prose mention of "openai-compatible harness" — update to "local harness."

```sh
grep -n "openai-compatible" CLAUDE.md
```

### Step 2.5: Update plugin READMEs and CLAUDE.md files

Run the bulk grep:

```sh
grep -rln "openai-compatible" plugins/ docs/ README.md 2>/dev/null \
  | grep -v node_modules | grep -v dist/ | grep -v archive/
```

Walk each file. For each, run a per-file `grep -n` and replace per these rules:

- **Prose** like "for the openai-compatible harness" → "for the local harness".
- **Filename references** like `harnesses/openai-compatible.json` → `harnesses/local.json`.
- **Harness identity literals** like `"openai-compatible"`, `"official/openai-compatible@0.1.0"`, `"local_openai-compatible"`, `"official_openai-compatible"` → the corresponding `local` variants (see Step 2.6 for the test-specific values).

Files expected (verify against your grep output — don't blindly trust this list):

- `plugins/llm-tool-approval/README.md`
- `plugins/llm-driver/README.md`
- `plugins/llm-axioms/README.md`
- `plugins/llm-memory/README.md`
- `plugins/llm-environment/README.md`
- `plugins/llm-events/README.md`
- `plugins/llm-contracts/README.md`
- `plugins/llm-contracts/CLAUDE.md`
- `plugins/llm-native-dispatch/CLAUDE.md`
- `plugins/llm-session-manager/README.md`
- `plugins/llm-tavily-search/CLAUDE.md`
- `plugins/openai-llm/README.md`
- `plugins/kaizen-config/README.md` (newly named per Task 1)
- `docs/PLUGIN_ARCHITECTURE.md`
- `README.md`

Some `package.json` files have a `description` field mentioning the harness. If so, update the description too:

```sh
grep -n "openai-compatible" plugins/*/package.json
```

### Step 2.6: Update test fixtures

Several tests assert against the harness identity literally. These must be updated atomically with the rename so `bun test` stays green.

- [ ] **Step 2.6.1: Audit all test files**

Run:
```sh
grep -rn "openai-compatible" plugins/*/test/ plugins/*/*.test.ts 2>/dev/null
```

- [ ] **Step 2.6.2: `plugins/llm-session-manager/test/harness-key.test.ts`**

Read the file. You will find lines like:
```ts
    expect(harnessKey({ ref: "official/openai-compatible@0.1.0" })).toBe("official_openai-compatible");
    ...
    expect(harnessKey({ jsonPath: "/repo/harnesses/openai-compatible.json" })).toBe("local_openai-compatible");
    expect(harnessKey({ jsonPath: "/repo/harnesses/openai-compatible/kaizen.json" })).toBe("local_openai-compatible");
```

Update to:
```ts
    expect(harnessKey({ ref: "official/local@0.1.0" })).toBe("official_local");
    ...
    expect(harnessKey({ jsonPath: "/repo/harnesses/local.json" })).toBe("local_local");
    expect(harnessKey({ jsonPath: "/repo/harnesses/local/kaizen.json" })).toBe("local_local");
```

If the test name or describe block references "openai-compatible", update for clarity.

- [ ] **Step 2.6.3: `plugins/kaizen-config/test/paths.test.ts`**

You will find analogous lines:
```ts
    expect(harnessKey({ ref: "official/openai-compatible@0.1.0" })).toBe("official_openai-compatible");
    ...
    expect(harnessKey({ jsonPath: "/abs/harnesses/openai-compatible.json" })).toBe("local_openai-compatible");
    ...
    expect(homeConfigPath("/u/me", "official_openai-compatible"))
      .toBe("/u/me/.kaizen/harnesses/official_openai-compatible/config.json");
```

Update each to the `local` equivalents:
```ts
    expect(harnessKey({ ref: "official/local@0.1.0" })).toBe("official_local");
    ...
    expect(harnessKey({ jsonPath: "/abs/harnesses/local.json" })).toBe("local_local");
    ...
    expect(homeConfigPath("/u/me", "official_local"))
      .toBe("/u/me/.kaizen/harnesses/official_local/config.json");
```

- [ ] **Step 2.6.4: `plugins/kaizen-config/index.test.ts`**

The test reads the harness JSON and compares versions. Update:
- The harness filename: `harnesses/openai-compatible.json` → `harnesses/local.json`.
- The `it(...)` description "package version matches openai-compatible harness …" → "… local harness …".

- [ ] **Step 2.6.5: Other test files surfaced by the grep**

Walk every other hit from Step 2.6.1 and apply the same rules:

- `plugins/llm-tool-approval/test/index.test.ts`
- `plugins/llm-tool-approval/test/slash.test.ts`
- `plugins/llm-events/index.test.ts`
- `plugins/llm-hooks-shell/test/index.test.ts`
- `plugins/llm-session-manager/test/index.test.ts`
- `plugins/llm-session-manager/test/paths.test.ts`

For each: read the file, identify whether the literal is being used as a harness id, a filename, or a harness-key path component, and update to the matching `local` value.

### Step 2.7: Verify

- [ ] **Step 2.7.1: Reinstall (in case any package.json descriptions changed)**

Run:
```sh
bun install
```
Expected: no changes or trivial lockfile-only changes.

- [ ] **Step 2.7.2: Run all tests**

Run:
```sh
bun test
```
Expected: same pass/fail set as baseline (Step 0.3). No new failures.

If a `harnessKey`-derived test fails, you missed a literal in Step 2.6. Re-run the audit grep.

- [ ] **Step 2.7.3: Boot the renamed harness**

Run:
```sh
kaizen --harness ./harnesses/local.json
```
Expected: harness boots, prompt comes up, `/config` slash command works. Quit out (Ctrl-D or `/exit` depending on TUI behavior).

If the harness boots but uses an empty config, that's expected — the new `harnessKey` is `local_local` and points to a fresh directory. The user can `mv` the old config dir per spec if they want to preserve it (see spec §2, "Migration strategy"). Not part of this plan.

- [ ] **Step 2.7.4: Final straggler grep**

Run:
```sh
grep -rn "openai-compatible" \
  plugins/ harnesses/ .kaizen/ docs/ README.md CLAUDE.md 2>/dev/null \
  | grep -v archive/ \
  | grep -v node_modules
```
Expected: zero hits.

If any remain, decide per-hit: is this prose ("for the openai-compatible harness" → update), a filename (update), a literal in a test (update), or an archived doc (skip, but it shouldn't have made it past the `archive/` filter)?

### Step 2.8: Commit

- [ ] **Step 2.8.1: Stage and commit**

Run:
```sh
git add -A
git status
```

Verify the diff includes:
- Harness file rename (`R harnesses/openai-compatible.json -> harnesses/local.json`)
- `.kaizen/marketplace.json` edit
- `plugins/llm-system-prompt/identity.ts` edit
- `CLAUDE.md` edit
- Multiple plugin README/CLAUDE.md edits
- `docs/PLUGIN_ARCHITECTURE.md` edit
- `README.md` edit
- Multiple test file edits
- Optional `bun.lock` change

Commit:
```sh
git commit -m "rename: openai-compatible harness -> local

Shorter name, pairs against claude-wrapper. harnessKey changes from
*_openai-compatible to *_local; users with existing on-disk config
can mv preserving paths (documented in the spec). See
docs/superpowers/specs/2026-05-20-rename-generic-plugins-design.md."
```

No `Co-Authored-By` line.

---

## Post-flight

- [ ] **Step 3.1: Full repo verification**

Run:
```sh
bun install && bun test
kaizen plugin validate plugins/kaizen-config
```
Expected: all green.

- [ ] **Step 3.2: Confirm git log**

Run:
```sh
git log --oneline -3
```
Expected: two new commits on `main` — the kaizen-config rename and the harness rename.

- [ ] **Step 3.3: Close the GitHub issue**

Run:
```sh
gh issue close 15 --repo CraightonH/kaizen-official-plugins \
  --comment "Resolved: renamed llm-config -> kaizen-config (truly generic) and openai-compatible harness -> local. Other llm-* plugins reviewed and kept as-is (LLM-shaped surface area). See docs/superpowers/specs/2026-05-20-rename-generic-plugins-design.md for rejection rationale and the deferred kaizen-hooks-shell refactor."
```
