# `new_skill` tool + CC-shaped layout for `llm-skills` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move `llm-skills` to CC-style directory-per-skill on-disk layout (`<root>/<name>/SKILL.md`) and add a `new_skill` tool that lets the LLM author a new skill mid-conversation through the approval gate, with the new skill registered before the tool returns.

**Architecture:** Refactor `scan.ts` to walk one level deep for `<dir>/SKILL.md` and carry `baseDir`; make `registry.rescan()` invoke `onChange` itself on changed snapshots so all rescan-triggers (turn-start, post-write) share one bump+emit path; add a new `new-skill.ts` module with `NEW_SKILL_SCHEMA` and a pure-factory handler that validates input, refuses on collision, atomically writes `SKILL.md`, triggers a rescan, and returns `{ name, path, scope, tokens }`. The tool is a plain `tools:registry` entry — `llm-tool-approval` gates it for free because the default `llm-skills:*` allow rule does not match the bare name `new_skill`.

**Tech Stack:** TypeScript / Bun, `bun:test`, `node:fs/promises`, `node:path`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-23-new-skill-tool-design.md`

---

## File Structure

**Modified files (under `plugins/llm-skills/`):**
- `scan.ts` — walker rewritten to one-level-deep CC layout; `ScannedFile` gains `baseDir`.
- `registry.ts` — `loadFromScanned` passes `baseDir` into the manifest; `rescan()` invokes `onChange` with `{ count }` when the snapshot changes; `RegistryDeps.onChange` signature widened.
- `index.ts` — `onChange` callback gains the bump-and-emit logic; `turn:start` handler reduces to `await registry.rescan()`; `new_skill` registered into `tools:registry` alongside `load_skill`; cleanup handle drained in `stop()`.
- `CLAUDE.md` — module map updated (new `new-skill.ts`, layout invariant change), invariant about "no multi-file skill support" relaxed to "this plugin only writes `SKILL.md`; sibling files are user-managed".
- `README.md` — discovery layout, frontmatter shape, `new_skill` tool surface, scope param.
- `test/fixtures/` — all fixture skill files restructured into `<name>/SKILL.md` form.
- `test/scan.test.ts`, `test/registry.test.ts`, `test/index.test.ts`, `test/integration.test.ts` — updated assertions for new layout + `baseDir` + reconciliation refactor.

**New files:**
- `new-skill.ts` — `NEW_SKILL_SCHEMA`, `validateNewSkillInput`, `resolveTargetPath`, `makeNewSkillHandler`.
- `test/new-skill.test.ts` — unit tests for validation, path resolution, collision, write, return shape.

**Out of scope (deferred):**
- Nested kaizen skill names (`<root>/group/name/SKILL.md`).
- `edit_skill` / `delete_skill` tools.
- Migration of pre-existing flat `<root>/<name>.md` files (zero adoption).

---

## Test commands

```sh
cd plugins/llm-skills && bun test                           # all tests
cd plugins/llm-skills && bun test test/scan.test.ts         # one file
cd plugins/llm-skills && bun test test/new-skill.test.ts    # the new module
```

---

## Task 1: Restructure test fixtures to CC layout

**Files:**
- Move: `test/fixtures/ok-flat/git-rebase.md` → `test/fixtures/ok-flat/git-rebase/SKILL.md`
- Move: `test/fixtures/ok-flat/python.md` → `test/fixtures/ok-flat/python/SKILL.md`
- Move: `test/fixtures/bad/{name-mismatch,no-frontmatter,missing-description,malformed,tokens-override}.md` → `test/fixtures/bad/<name>/SKILL.md`
- Move: `test/fixtures/project/override.md` → `test/fixtures/project/override/SKILL.md`
- Move: `test/fixtures/user/override.md` → `test/fixtures/user/override/SKILL.md`
- Create: `test/fixtures/ok-flat/with-siblings/SKILL.md` (for sibling-file ignored test)
- Create: `test/fixtures/ok-flat/with-siblings/notes.md` (the ignored sibling)
- Leave: `test/fixtures/ok-nested/**` unchanged — repurposed as "nested-not-scanned" fixture (no `<dir>/SKILL.md`, scan returns empty).

- [ ] **Step 1: Create the target directories and move files**

```sh
cd plugins/llm-skills/test/fixtures

# ok-flat: existing skills
mkdir -p ok-flat/git-rebase ok-flat/python ok-flat/with-siblings
git mv ok-flat/git-rebase.md ok-flat/git-rebase/SKILL.md
git mv ok-flat/python.md ok-flat/python/SKILL.md

# ok-flat: new sibling-file fixture
cat > ok-flat/with-siblings/SKILL.md <<'EOF'
---
name: with-siblings
description: A skill that has companion files in its directory.
---
Body text.
EOF
cat > ok-flat/with-siblings/notes.md <<'EOF'
This sibling file should not be discovered by the scanner.
EOF

# bad: each bad fixture into its own dir
for n in name-mismatch no-frontmatter missing-description malformed tokens-override; do
  mkdir -p bad/$n
  git mv bad/$n.md bad/$n/SKILL.md
done

# project / user override
mkdir -p project/override user/override
git mv project/override.md project/override/SKILL.md
git mv user/override.md user/override/SKILL.md
```

- [ ] **Step 2: Verify fixture layout**

Run:
```sh
cd plugins/llm-skills
find test/fixtures -name SKILL.md | sort
find test/fixtures -name "*.md" -not -name SKILL.md | sort
```

Expected first command output (exact set):
```
test/fixtures/bad/malformed/SKILL.md
test/fixtures/bad/missing-description/SKILL.md
test/fixtures/bad/name-mismatch/SKILL.md
test/fixtures/bad/no-frontmatter/SKILL.md
test/fixtures/bad/tokens-override/SKILL.md
test/fixtures/ok-flat/git-rebase/SKILL.md
test/fixtures/ok-flat/python/SKILL.md
test/fixtures/ok-flat/with-siblings/SKILL.md
test/fixtures/project/override/SKILL.md
test/fixtures/user/override/SKILL.md
```

Expected second command output (non-SKILL .md files that should still exist):
```
test/fixtures/ok-flat/with-siblings/notes.md
test/fixtures/ok-nested/ops/k8s/kubectl-debug.md
test/fixtures/ok-nested/python/poetry-deps.md
```

- [ ] **Step 3: Run the test suite (expect failures — pre-refactor)**

Run: `cd plugins/llm-skills && bun test`
Expected: many failures in `scan.test.ts`, `registry.test.ts`, `index.test.ts`, `integration.test.ts`. We will fix them in subsequent tasks. **Do not commit until tests pass** — fixture moves are bundled into Task 2's commit.

---

## Task 2: Refactor `scan.ts` to walk CC layout

**Files:**
- Modify: `plugins/llm-skills/scan.ts`
- Modify: `plugins/llm-skills/test/scan.test.ts`

- [ ] **Step 1: Update `scan.test.ts` expectations**

Replace the entire file contents with:

```ts
import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { scanRoot } from "../scan.ts";

const FIXTURES = join(import.meta.dir, "fixtures");

describe("scanRoot", () => {
  it("returns [] for a non-existent root", async () => {
    const r = await scanRoot(join(FIXTURES, "does-not-exist"));
    expect(r).toEqual([]);
  });

  it("discovers <name>/SKILL.md as a skill named <name>", async () => {
    const r = await scanRoot(join(FIXTURES, "ok-flat"));
    const byName = Object.fromEntries(r.map(f => [f.relativeName, f]));
    expect(Object.keys(byName).sort()).toEqual(["git-rebase", "python", "with-siblings"]);
    expect(byName["git-rebase"].body).toContain("Step 1");
    expect(byName["git-rebase"].absolutePath.endsWith("/git-rebase/SKILL.md")).toBe(true);
  });

  it("sets baseDir to the skill's directory (parent of SKILL.md)", async () => {
    const r = await scanRoot(join(FIXTURES, "ok-flat"));
    const git = r.find(f => f.relativeName === "git-rebase")!;
    expect(git.baseDir).toBe(join(FIXTURES, "ok-flat", "git-rebase"));
    expect(git.absolutePath).toBe(join(FIXTURES, "ok-flat", "git-rebase", "SKILL.md"));
  });

  it("ignores sibling files inside a skill directory", async () => {
    const r = await scanRoot(join(FIXTURES, "ok-flat"));
    // with-siblings/SKILL.md is found; with-siblings/notes.md must not appear.
    expect(r.some(f => f.absolutePath.endsWith("notes.md"))).toBe(false);
    expect(r.some(f => f.relativeName === "with-siblings")).toBe(true);
  });

  it("ignores nested layouts (e.g. <root>/group/name/SKILL.md)", async () => {
    // ok-nested has <root>/{ops,python}/... but no <root>/<X>/SKILL.md at depth 1.
    const r = await scanRoot(join(FIXTURES, "ok-nested"));
    expect(r).toEqual([]);
  });

  it("ignores dotfiles and directories starting with a dot", async () => {
    const r = await scanRoot(join(FIXTURES, "ok-flat"));
    for (const f of r) {
      expect(f.relativeName.startsWith(".")).toBe(false);
    }
  });

  it("returns stable alphabetic order regardless of readdir order", async () => {
    const r = await scanRoot(join(FIXTURES, "ok-flat"));
    const names = r.map(f => f.relativeName);
    expect([...names].sort()).toEqual(names);
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `cd plugins/llm-skills && bun test test/scan.test.ts`
Expected: failures (the current walker recurses; new tests assert flat-only).

- [ ] **Step 3: Rewrite `scan.ts`**

Replace the entire contents of `plugins/llm-skills/scan.ts` with:

```ts
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export interface ScannedFile {
  /** Path-derived skill name. Equal to the immediate subdirectory of the scan root. */
  relativeName: string;
  /** Absolute path to the SKILL.md file. */
  absolutePath: string;
  /** Absolute path to the skill's directory (parent of SKILL.md). Surfaced via SkillManifest.baseDir. */
  baseDir: string;
  /** Verbatim contents of SKILL.md (frontmatter + body). */
  body: string;
}

/**
 * Walk `<absRoot>/<name>/SKILL.md` entries (one level deep). Returns [] if the
 * root does not exist or is not a directory. Each entry's `relativeName` is the
 * `<name>` segment. Sibling files inside the skill directory are ignored.
 * Nested directories (e.g. `<absRoot>/group/name/SKILL.md`) are not scanned.
 */
export async function scanRoot(absRoot: string): Promise<ScannedFile[]> {
  let rootStat;
  try {
    rootStat = await stat(absRoot);
  } catch {
    return [];
  }
  if (!rootStat.isDirectory()) return [];

  let entries;
  try {
    entries = await readdir(absRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const out: ScannedFile[] = [];
  for (const ent of entries) {
    if (ent.name.startsWith(".")) continue;
    // Accept directories and symlinks (which may resolve to directories).
    if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
    const baseDir = join(absRoot, ent.name);
    const skillFile = join(baseDir, "SKILL.md");
    let body: string;
    try {
      body = await readFile(skillFile, "utf8");
    } catch {
      // Missing SKILL.md, unreadable, or symlink target isn't a dir → skip silently.
      continue;
    }
    out.push({
      relativeName: ent.name,
      absolutePath: skillFile,
      baseDir,
      body,
    });
  }

  out.sort((a, b) => a.relativeName.localeCompare(b.relativeName));
  return out;
}
```

- [ ] **Step 4: Run the scan tests to confirm they pass**

Run: `cd plugins/llm-skills && bun test test/scan.test.ts`
Expected: all green.

- [ ] **Step 5: Commit fixtures + scan refactor together**

```sh
cd /Users/chancock/git/kaizen-official-plugins
git add plugins/llm-skills/scan.ts \
        plugins/llm-skills/test/scan.test.ts \
        plugins/llm-skills/test/fixtures
git status   # confirm the moves are recorded as renames
git commit -m "llm-skills: CC-style scan layout (<name>/SKILL.md)"
```

---

## Task 3: Carry `baseDir` through the registry

**Files:**
- Modify: `plugins/llm-skills/registry.ts` (the `loadFromScanned` helper)
- Modify: `plugins/llm-skills/test/registry.test.ts`

- [ ] **Step 1: Update one registry test first (TDD)**

Edit `plugins/llm-skills/test/registry.test.ts`. Replace the contents of the `describe("registry — discovery basics", ...)` block with the updated assertions (new fixture layout + baseDir):

```ts
describe("registry — discovery basics", () => {
  it("populates from a flat CC-shape directory", async () => {
    const d = deps({ userRoot: join(FIXTURES, "ok-flat") });
    const reg = makeRegistry(d);
    await reg.rescan();
    const names = reg.list().map(m => m.name);
    expect(names).toEqual(["git-rebase", "python", "with-siblings"]);
  });

  it("sets baseDir on each manifest to the skill's directory", async () => {
    const d = deps({ userRoot: join(FIXTURES, "ok-flat") });
    const reg = makeRegistry(d);
    await reg.rescan();
    const git = reg.list().find(m => m.name === "git-rebase")!;
    expect(git.baseDir).toBe(join(FIXTURES, "ok-flat", "git-rebase"));
  });

  it("returns [] for a nested directory tree (no <name>/SKILL.md at depth 1)", async () => {
    const d = deps({ userRoot: join(FIXTURES, "ok-nested") });
    const reg = makeRegistry(d);
    await reg.rescan();
    expect(reg.list()).toEqual([]);
  });

  it("uses tokens override when present", async () => {
    const d = deps({ userRoot: join(FIXTURES, "bad") });
    const reg = makeRegistry(d);
    await reg.rescan();
    const m = reg.list().find(x => x.name === "tokens-override");
    expect(m).toBeDefined();
    expect(m!.tokens).toBe(999);
  });

  it("computes heuristic tokens when override absent", async () => {
    const d = deps({ userRoot: join(FIXTURES, "ok-flat") });
    const reg = makeRegistry(d);
    await reg.rescan();
    const git = reg.list().find(x => x.name === "git-rebase")!;
    expect(git.tokens).toBe(420);   // frontmatter override in fixture
    const py = reg.list().find(x => x.name === "python")!;
    expect(py.tokens).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails on `baseDir` absence**

Run: `cd plugins/llm-skills && bun test test/registry.test.ts`
Expected: the "sets baseDir" case fails — registry currently does not propagate baseDir.

- [ ] **Step 3: Update `loadFromScanned` to set `baseDir`**

In `plugins/llm-skills/registry.ts`, modify the `loadFromScanned` function body. Change:

```ts
const manifest: SkillManifest = {
  name: f.relativeName,
  description: parsed.manifest.description,
  tokens,
};
```

to:

```ts
const manifest: SkillManifest = {
  name: f.relativeName,
  description: parsed.manifest.description,
  tokens,
  baseDir: f.baseDir,
};
```

- [ ] **Step 4: Re-run the registry tests**

Run: `cd plugins/llm-skills && bun test test/registry.test.ts`
Expected: all green (including the existing precedence tests, since fixture renames in Task 1 already updated `project/override/SKILL.md` and `user/override/SKILL.md`).

- [ ] **Step 5: Commit**

```sh
cd /Users/chancock/git/kaizen-official-plugins
git add plugins/llm-skills/registry.ts plugins/llm-skills/test/registry.test.ts
git commit -m "llm-skills: carry baseDir from scan into SkillManifest"
```

---

## Task 4: `rescan()` fires `onChange` on changed snapshots

The current code path only fires `onChange` from programmatic `register`/`unregister`. The `turn:start` handler in `index.ts` separately bumps + emits. Centralising the bump+emit into `onChange` removes the duplication and lets `new_skill` reuse it.

**Files:**
- Modify: `plugins/llm-skills/registry.ts` (signature of `RegistryDeps.onChange` + the `rescan()` body)
- Modify: `plugins/llm-skills/test/registry.test.ts` (add coverage)

- [ ] **Step 1: Add a failing test for the new onChange contract**

Append to `plugins/llm-skills/test/registry.test.ts`:

```ts
describe("registry — onChange invocations", () => {
  it("fires onChange with { count } when rescan detects a snapshot change", async () => {
    const d = deps({ userRoot: join(FIXTURES, "ok-flat") });
    const onChange = mock((_info?: { count: number }) => {});
    const reg = makeRegistry({ ...d, onChange });
    const r = await reg.rescan();
    expect(r.changed).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(1);
    const lastCall = onChange.mock.calls.at(-1)!;
    expect(lastCall[0]).toEqual({ count: r.count });
  });

  it("does not fire onChange when rescan reports no change", async () => {
    const d = deps({ userRoot: join(FIXTURES, "ok-flat") });
    const onChange = mock((_info?: { count: number }) => {});
    const reg = makeRegistry({ ...d, onChange });
    await reg.rescan();
    onChange.mockClear();
    const r2 = await reg.rescan();
    expect(r2.changed).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("fires onChange with no info on programmatic register/unregister", async () => {
    const onChange = mock((_info?: { count: number }) => {});
    const reg = makeRegistry({ ...deps(), onChange });
    await reg.rescan();
    onChange.mockClear();
    const off = reg.register({ name: "p", description: "d", tokens: 1 }, async () => "x");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toBeUndefined();
    off();
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange.mock.calls[1][0]).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to confirm failure**

Run: `cd plugins/llm-skills && bun test test/registry.test.ts`
Expected: the new `describe` block fails — current `rescan()` does not invoke `onChange`.

- [ ] **Step 3: Update `RegistryDeps.onChange` and `rescan()` in `registry.ts`**

Change the `RegistryDeps` interface:

```ts
export interface RegistryDeps {
  projectRoot?: string;
  userRoot?: string;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  /**
   * Called whenever the registry's visible set may have changed.
   * - Programmatic register/unregister: invoked with no argument.
   * - Rescan that detected a snapshot change: invoked with `{ count }`.
   * The `count` lets the harness emit `skill:available-changed` from a single site.
   */
  onChange?: (info?: { count: number }) => void;
}
```

Update the `rescan` method body. Replace:

```ts
async rescan(): Promise<RescanResult> {
  const projFiles = deps.projectRoot ? await scanRoot(deps.projectRoot) : [];
  const userFiles = deps.userRoot ? await scanRoot(deps.userRoot) : [];
  project = loadFromScanned(projFiles, "project", deps.error, deps.warn);
  user = loadFromScanned(userFiles, "user", deps.error, deps.warn);
  const m = merged();
  const snap = snapshotKeys(m);
  const changed = snap !== lastSnapshot;
  lastSnapshot = snap;
  return { changed, count: m.size };
},
```

with:

```ts
async rescan(): Promise<RescanResult> {
  const projFiles = deps.projectRoot ? await scanRoot(deps.projectRoot) : [];
  const userFiles = deps.userRoot ? await scanRoot(deps.userRoot) : [];
  project = loadFromScanned(projFiles, "project", deps.error, deps.warn);
  user = loadFromScanned(userFiles, "user", deps.error, deps.warn);
  const m = merged();
  const snap = snapshotKeys(m);
  const changed = snap !== lastSnapshot;
  lastSnapshot = snap;
  const count = m.size;
  if (changed) deps.onChange?.({ count });
  return { changed, count };
},
```

- [ ] **Step 4: Run the registry tests**

Run: `cd plugins/llm-skills && bun test test/registry.test.ts`
Expected: all green.

- [ ] **Step 5: Commit**

```sh
cd /Users/chancock/git/kaizen-official-plugins
git add plugins/llm-skills/registry.ts plugins/llm-skills/test/registry.test.ts
git commit -m "llm-skills: fire onChange from rescan when snapshot changes"
```

---

## Task 5: Consolidate bump + emit into the `onChange` callback in `index.ts`

**Files:**
- Modify: `plugins/llm-skills/index.ts`
- Modify: `plugins/llm-skills/test/index.test.ts`

The existing `turn:start` handler in `index.ts` separately bumps + emits when rescan reports change. After Task 4, `onChange` already fires on rescan-change, so the inline bump+emit in `turn:start` is now duplicated. Move both into `onChange` and reduce `turn:start` to `await registry.rescan()`.

- [ ] **Step 1: Update the existing index test that asserts emit-on-initial-scan**

In `plugins/llm-skills/test/index.test.ts`, the test `"provides skills:registry with list()=[] and emits skill:available-changed once"` already asserts the initial-scan emit. With this refactor, the initial emit must come from inside the `onChange` callback fired by the initial `rescan()`. The existing assertion (`events.length === 1`, `count === 0`) must continue to hold. **No change to the test body** — we verify after the refactor.

Add a new test that exercises the consolidated path on a fixture-driven scan. Append to the `describe("plugin setup — populated user root via env override", ...)` block:

```ts
  it("emits skill:available-changed exactly once on initial scan when skills exist", async () => {
    const ps = makePromptSystem();
    const { ctx, emitted } = makeCtx({
      env: { KAIZEN_LLM_SKILLS_PATH: join(FIXTURES, "ok-flat") },
      promptSystem: ps.service,
    });
    await plugin.setup(ctx);
    const events = emitted.filter(e => e.name === "skill:available-changed");
    expect(events.length).toBe(1);
    expect((events[0].payload as any).count).toBe(3);   // git-rebase, python, with-siblings
  });
```

- [ ] **Step 2: Refactor `index.ts`**

In `plugins/llm-skills/index.ts`:

Replace the `makeRegistry({...})` call's `onChange` from:

```ts
onChange: () => { sectionHandle?.bumpGeneration(); },
```

to:

```ts
onChange: (info) => {
  sectionHandle?.bumpGeneration();
  if (info) void ctx.emit("skill:available-changed", { count: info.count });
},
```

Replace the initial-scan block (the lines starting `const initial = await registry.rescan();` through `void ctx.emit("skill:available-changed", { count: initial.count });`) with:

```ts
// Initial scan. onChange fires the bump + emit when the empty→populated
// snapshot transition is detected.
const initial = await registry.rescan();
```

Then delete the now-redundant explicit `void ctx.emit(...)` line that immediately followed. **Keep** the `ctx.provideService<SkillsRegistryService>("skills:registry", registry);` call and the `sectionHandle = promptSystem.register({...})` block. **However**, the existing code registers the section *after* `registry.rescan()` — but the `onChange` callback closes over `sectionHandle`, which is still `undefined` at the time of the initial rescan. To fix:

Move the prompt-section registration **before** the initial `await registry.rescan()` call. The block ordering becomes:

```ts
// Resolve prompt:registry early so onChange can call bumpGeneration.
const promptSystem = ctx.useService<SystemPromptService>("prompt:registry");

const registry: SkillsRegistryServiceImpl = makeRegistry({
  projectRoot,
  userRoot,
  warn: (m) => ctx.log(m),
  error: (m) => { void ctx.emit("harness:error", { message: m }); },
  onChange: (info) => {
    sectionHandle?.bumpGeneration();
    if (info) void ctx.emit("skill:available-changed", { count: info.count });
  },
});

ctx.provideService<SkillsRegistryService>("skills:registry", registry);

// Register prompt:system section BEFORE the initial scan so onChange can bump.
if (promptSystem) {
  sectionHandle = promptSystem.register({
    id: "llm-skills:available",
    priority: 160,
    title: "Available skills",
    render: () => buildSkillsBlock(registry.list()),
  });
} else {
  void ctx.emit("harness:error", { message: "llm-skills: missing required service(s): prompt:registry; available-skills section disabled" });
}

// Initial scan. If skills exist, onChange fires once (bump + emit).
const initial = await registry.rescan();

// Empty-registry case: onChange does not fire (no change detected on first
// rescan when the snapshot stays empty), so emit once explicitly so the
// existing "emits skill:available-changed once" contract holds.
if (initial.count === 0) {
  void ctx.emit("skill:available-changed", { count: 0 });
}
```

Then replace the `turn:start` handler body. Change:

```ts
ctx.on("turn:start", async () => {
  const now = Date.now();
  if (now - lastScanAt < interval) return;
  lastScanAt = now;
  const r = await registry.rescan();
  if (r.changed) {
    void ctx.emit("skill:available-changed", { count: r.count });
    sectionHandle?.bumpGeneration();
  }
});
```

to:

```ts
ctx.on("turn:start", async () => {
  const now = Date.now();
  if (now - lastScanAt < interval) return;
  lastScanAt = now;
  // bump + emit happen via onChange when the snapshot changes.
  await registry.rescan();
});
```

> **Note on the empty-snapshot edge case:** The first `rescan()` against an empty disk transitions `lastSnapshot` from `""` to `""` (no change), so `onChange` does not fire. The existing test contract requires `skill:available-changed` to fire once after setup even on empty. The explicit emit guard above preserves that contract without polluting `onChange`.

- [ ] **Step 3: Run the full test suite**

Run: `cd plugins/llm-skills && bun test`
Expected: all green. Pay particular attention to:
- `index.test.ts > "emits skill:available-changed once"` (count=0 case) — covered by the explicit empty emit.
- `index.test.ts > "calls bumpGeneration after initial scan"` — bump happens via the explicit empty emit path? No — bump fires from onChange, which doesn't fire on empty. **This test must be updated.**

Update the test "calls bumpGeneration after initial scan" in `index.test.ts`. Replace its body with:

```ts
it("calls bumpGeneration after initial scan when skills are present", async () => {
  const ps = makePromptSystem();
  const { ctx } = makeCtx({
    env: { KAIZEN_LLM_SKILLS_PATH: join(FIXTURES, "ok-flat") },
    promptSystem: ps.service,
  });
  await plugin.setup(ctx);
  expect(ps.bumpGeneration).toHaveBeenCalled();
});
```

(Keep the test description targeted at the populated case — bump on an empty registry is not load-bearing because there's no section content to refresh.)

- [ ] **Step 4: Re-run the test suite**

Run: `cd plugins/llm-skills && bun test`
Expected: all green.

- [ ] **Step 5: Commit**

```sh
cd /Users/chancock/git/kaizen-official-plugins
git add plugins/llm-skills/index.ts plugins/llm-skills/test/index.test.ts
git commit -m "llm-skills: consolidate bump+emit into onChange callback"
```

---

## Task 6: `NEW_SKILL_SCHEMA` and validation

This task introduces the new module file and the schema constant. Validation logic comes next (Task 7) and the FS-touching handler after that (Task 8). Splitting keeps each step small.

**Files:**
- Create: `plugins/llm-skills/new-skill.ts`
- Create: `plugins/llm-skills/test/new-skill.test.ts`

- [ ] **Step 1: Write the failing schema test**

Create `plugins/llm-skills/test/new-skill.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { NEW_SKILL_SCHEMA } from "../new-skill.ts";

describe("NEW_SKILL_SCHEMA", () => {
  it("declares the contract for the new_skill tool", () => {
    expect(NEW_SKILL_SCHEMA.name).toBe("new_skill");
    expect(NEW_SKILL_SCHEMA.description).toMatch(/skill/i);
    expect(NEW_SKILL_SCHEMA.parameters.type).toBe("object");
    expect(NEW_SKILL_SCHEMA.parameters.additionalProperties).toBe(false);
    expect(NEW_SKILL_SCHEMA.parameters.required?.sort()).toEqual(["body", "description", "name", "scope"]);
  });

  it("scope is a string enum of 'project' | 'user'", () => {
    const scope = NEW_SKILL_SCHEMA.parameters.properties?.scope as any;
    expect(scope).toBeDefined();
    expect(scope.type).toBe("string");
    expect(scope.enum?.sort()).toEqual(["project", "user"]);
  });

  it("is tagged skills/synthetic/mutating", () => {
    expect(NEW_SKILL_SCHEMA.tags?.sort()).toEqual(["mutating", "skills", "synthetic"]);
  });
});
```

- [ ] **Step 2: Run the test to confirm failure**

Run: `cd plugins/llm-skills && bun test test/new-skill.test.ts`
Expected: failure — module does not exist.

- [ ] **Step 3: Create `new-skill.ts` with the schema only**

Create `plugins/llm-skills/new-skill.ts`:

```ts
import type { ToolSchema } from "llm-contracts/public";

export const NEW_SKILL_SCHEMA: ToolSchema = {
  name: "new_skill",
  description:
    "Author a new kaizen-native skill from this conversation. Writes a SKILL.md " +
    "file with the supplied frontmatter and body into either the project's " +
    ".kaizen/skills/ directory or the user's ~/.kaizen/skills/ directory. Refuses " +
    "if a skill with that name already exists in the target scope. The new skill " +
    "is registered before the tool returns.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description:
          "Skill name. Single segment, lowercase, [a-z0-9_-], starting with [a-z0-9]. " +
          "Becomes the directory name under the scope's root.",
      },
      description: {
        type: "string",
        description:
          "One-line description shown to the LLM in the Available skills prompt section. " +
          "≤200 chars, no newlines.",
      },
      body: {
        type: "string",
        description:
          "Markdown body of the skill (the part after the frontmatter). Non-empty.",
      },
      scope: {
        type: "string",
        enum: ["project", "user"],
        description:
          "Where to write: 'project' for <cwd>/.kaizen/skills/, 'user' for ~/.kaizen/skills/.",
      },
    },
    required: ["name", "description", "body", "scope"],
    additionalProperties: false,
  },
  tags: ["skills", "synthetic", "mutating"],
};
```

- [ ] **Step 4: Run the schema test**

Run: `cd plugins/llm-skills && bun test test/new-skill.test.ts`
Expected: all green.

- [ ] **Step 5: Commit**

```sh
cd /Users/chancock/git/kaizen-official-plugins
git add plugins/llm-skills/new-skill.ts plugins/llm-skills/test/new-skill.test.ts
git commit -m "llm-skills: NEW_SKILL_SCHEMA for new_skill tool"
```

---

## Task 7: Input validation

**Files:**
- Modify: `plugins/llm-skills/new-skill.ts` (add `validateNewSkillInput`)
- Modify: `plugins/llm-skills/test/new-skill.test.ts` (validation cases)

- [ ] **Step 1: Write the failing validation tests**

Append to `plugins/llm-skills/test/new-skill.test.ts`:

```ts
import { validateNewSkillInput } from "../new-skill.ts";

describe("validateNewSkillInput", () => {
  const good = { name: "git-rebase", description: "How to rebase cleanly.", body: "Step 1.", scope: "user" as const };

  it("accepts a valid input", () => {
    expect(() => validateNewSkillInput(good)).not.toThrow();
  });

  it("rejects non-object args", () => {
    expect(() => validateNewSkillInput(null)).toThrow(/args must be an object/i);
    expect(() => validateNewSkillInput("foo")).toThrow(/args must be an object/i);
    expect(() => validateNewSkillInput(7 as any)).toThrow(/args must be an object/i);
  });

  it("rejects missing or non-string name", () => {
    expect(() => validateNewSkillInput({ ...good, name: undefined } as any)).toThrow(/name/i);
    expect(() => validateNewSkillInput({ ...good, name: 7 } as any)).toThrow(/name/i);
  });

  it("rejects bad name shape", () => {
    expect(() => validateNewSkillInput({ ...good, name: "Foo" })).toThrow(/name must match/i);
    expect(() => validateNewSkillInput({ ...good, name: "-foo" })).toThrow(/name must match/i);
    expect(() => validateNewSkillInput({ ...good, name: "foo/bar" })).toThrow(/name must match/i);
    expect(() => validateNewSkillInput({ ...good, name: ".." })).toThrow(/name must match/i);
    expect(() => validateNewSkillInput({ ...good, name: "foo.bar" })).toThrow(/name must match/i);
    expect(() => validateNewSkillInput({ ...good, name: " foo" })).toThrow(/name must match/i);
  });

  it("rejects name > 64 chars", () => {
    expect(() => validateNewSkillInput({ ...good, name: "a".repeat(65) })).toThrow(/name must be ≤ 64/);
  });

  it("accepts name exactly 64 chars", () => {
    expect(() => validateNewSkillInput({ ...good, name: "a".repeat(64) })).not.toThrow();
  });

  it("rejects missing or non-string description", () => {
    expect(() => validateNewSkillInput({ ...good, description: undefined } as any)).toThrow(/description/i);
    expect(() => validateNewSkillInput({ ...good, description: 7 } as any)).toThrow(/description/i);
  });

  it("rejects empty/whitespace description", () => {
    expect(() => validateNewSkillInput({ ...good, description: "" })).toThrow(/description must be non-empty/i);
    expect(() => validateNewSkillInput({ ...good, description: "   " })).toThrow(/description must be non-empty/i);
  });

  it("rejects multi-line description", () => {
    expect(() => validateNewSkillInput({ ...good, description: "line1\nline2" })).toThrow(/single-line/i);
    expect(() => validateNewSkillInput({ ...good, description: "line1\rline2" })).toThrow(/single-line/i);
  });

  it("rejects description > 200 chars", () => {
    expect(() => validateNewSkillInput({ ...good, description: "a".repeat(201) })).toThrow(/≤ 200/);
  });

  it("accepts description exactly 200 chars", () => {
    expect(() => validateNewSkillInput({ ...good, description: "a".repeat(200) })).not.toThrow();
  });

  it("rejects missing or non-string body", () => {
    expect(() => validateNewSkillInput({ ...good, body: undefined } as any)).toThrow(/body/i);
    expect(() => validateNewSkillInput({ ...good, body: 7 } as any)).toThrow(/body/i);
  });

  it("rejects whitespace-only body", () => {
    expect(() => validateNewSkillInput({ ...good, body: "" })).toThrow(/body must be non-empty/i);
    expect(() => validateNewSkillInput({ ...good, body: "   \n  " })).toThrow(/body must be non-empty/i);
  });

  it("rejects bad scope", () => {
    expect(() => validateNewSkillInput({ ...good, scope: "global" } as any)).toThrow(/scope/i);
    expect(() => validateNewSkillInput({ ...good, scope: undefined } as any)).toThrow(/scope/i);
  });
});
```

- [ ] **Step 2: Run the tests to confirm failure**

Run: `cd plugins/llm-skills && bun test test/new-skill.test.ts`
Expected: the `validateNewSkillInput` block fails — function not exported.

- [ ] **Step 3: Implement `validateNewSkillInput` in `new-skill.ts`**

Append to `plugins/llm-skills/new-skill.ts`:

```ts
export interface NewSkillInput {
  name: string;
  description: string;
  body: string;
  scope: "project" | "user";
}

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
const NAME_MAX = 64;
const DESCRIPTION_MAX = 200;

/**
 * Validate the shape and values of a new_skill input. Throws on the first
 * violation with a message naming the field and the rule. Does not touch the
 * filesystem.
 */
export function validateNewSkillInput(raw: unknown): asserts raw is NewSkillInput {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("new_skill: args must be an object");
  }
  const { name, description, body, scope } = raw as Record<string, unknown>;

  if (typeof name !== "string") throw new Error("new_skill: 'name' is required and must be a string");
  if (!NAME_RE.test(name)) {
    throw new Error("new_skill: name must match [a-z0-9_-], starting with [a-z0-9]");
  }
  if (name.length > NAME_MAX) {
    throw new Error(`new_skill: name must be ≤ ${NAME_MAX} chars (got ${name.length})`);
  }

  if (typeof description !== "string") {
    throw new Error("new_skill: 'description' is required and must be a string");
  }
  if (description.trim().length === 0) {
    throw new Error("new_skill: description must be non-empty");
  }
  if (description.includes("\n") || description.includes("\r")) {
    throw new Error("new_skill: description must be single-line (no \\n or \\r)");
  }
  if (description.length > DESCRIPTION_MAX) {
    throw new Error(`new_skill: description must be ≤ ${DESCRIPTION_MAX} chars (got ${description.length})`);
  }

  if (typeof body !== "string") {
    throw new Error("new_skill: 'body' is required and must be a string");
  }
  if (body.trim().length === 0) {
    throw new Error("new_skill: body must be non-empty");
  }

  if (scope !== "project" && scope !== "user") {
    throw new Error("new_skill: 'scope' must be \"project\" or \"user\"");
  }
}
```

- [ ] **Step 4: Run the validation tests**

Run: `cd plugins/llm-skills && bun test test/new-skill.test.ts`
Expected: all green.

- [ ] **Step 5: Commit**

```sh
cd /Users/chancock/git/kaizen-official-plugins
git add plugins/llm-skills/new-skill.ts plugins/llm-skills/test/new-skill.test.ts
git commit -m "llm-skills: validate new_skill input"
```

---

## Task 8: Path resolution + collision check (pure)

**Files:**
- Modify: `plugins/llm-skills/new-skill.ts`
- Modify: `plugins/llm-skills/test/new-skill.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `plugins/llm-skills/test/new-skill.test.ts`:

```ts
import { mkdtemp, writeFile, mkdir, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTargetPath, assertNoCollision } from "../new-skill.ts";

describe("resolveTargetPath", () => {
  it("returns <projectRoot>/<name>/SKILL.md for scope=project", () => {
    const out = resolveTargetPath({ name: "foo", scope: "project", projectRoot: "/p", userRoot: "/u" });
    expect(out).toEqual({ baseDir: "/p/foo", file: "/p/foo/SKILL.md" });
  });

  it("returns <userRoot>/<name>/SKILL.md for scope=user", () => {
    const out = resolveTargetPath({ name: "foo", scope: "user", projectRoot: "/p", userRoot: "/u" });
    expect(out).toEqual({ baseDir: "/u/foo", file: "/u/foo/SKILL.md" });
  });
});

describe("assertNoCollision", () => {
  async function makeTmpRoot() {
    return mkdtemp(join(tmpdir(), "new-skill-"));
  }

  it("returns successfully when nothing exists at the target", async () => {
    const root = await makeTmpRoot();
    await expect(assertNoCollision(join(root, "foo"))).resolves.toBeUndefined();
    await rm(root, { recursive: true });
  });

  it("throws when a directory already exists at the target (even without SKILL.md)", async () => {
    const root = await makeTmpRoot();
    await mkdir(join(root, "foo"), { recursive: true });
    await expect(assertNoCollision(join(root, "foo"))).rejects.toThrow(/already exists/);
    await rm(root, { recursive: true });
  });

  it("throws when a file exists at the target", async () => {
    const root = await makeTmpRoot();
    await writeFile(join(root, "foo"), "");
    await expect(assertNoCollision(join(root, "foo"))).rejects.toThrow(/already exists/);
    await rm(root, { recursive: true });
  });

  it("throws when a symlink exists at the target (and does not follow it)", async () => {
    const root = await makeTmpRoot();
    await symlink("/tmp", join(root, "foo"));
    await expect(assertNoCollision(join(root, "foo"))).rejects.toThrow(/already exists/);
    await rm(root, { recursive: true });
  });
});
```

- [ ] **Step 2: Run the tests to confirm failure**

Run: `cd plugins/llm-skills && bun test test/new-skill.test.ts`
Expected: failure — `resolveTargetPath` and `assertNoCollision` not exported.

- [ ] **Step 3: Implement both functions in `new-skill.ts`**

Append to `plugins/llm-skills/new-skill.ts`:

```ts
import { lstat } from "node:fs/promises";
import { join } from "node:path";

export interface ResolveTargetPathArgs {
  name: string;
  scope: "project" | "user";
  projectRoot: string;
  userRoot: string;
}

export interface ResolvedTargetPath {
  /** Absolute path to the skill's directory (will be created). */
  baseDir: string;
  /** Absolute path to the SKILL.md file (will be written). */
  file: string;
}

/**
 * Compute the on-disk target for a new skill. Pure — no filesystem access.
 */
export function resolveTargetPath(args: ResolveTargetPathArgs): ResolvedTargetPath {
  const root = args.scope === "project" ? args.projectRoot : args.userRoot;
  const baseDir = join(root, args.name);
  const file = join(baseDir, "SKILL.md");
  return { baseDir, file };
}

/**
 * Refuse to write if anything exists at `baseDir`. Uses `lstat` so a symlink at
 * the target is treated as a collision (not followed). Throws on collision;
 * resolves with `undefined` if the path is free.
 */
export async function assertNoCollision(baseDir: string): Promise<void> {
  try {
    await lstat(baseDir);
  } catch (err: any) {
    if (err && err.code === "ENOENT") return;
    throw err;
  }
  throw new Error(`new_skill: skill already exists at ${baseDir}`);
}
```

> The two new top-of-file `import` lines should be merged with the existing imports — the final import block at the top of `new-skill.ts` should read:
>
> ```ts
> import { lstat } from "node:fs/promises";
> import { join } from "node:path";
> import type { ToolSchema } from "llm-contracts/public";
> ```

- [ ] **Step 4: Run the tests**

Run: `cd plugins/llm-skills && bun test test/new-skill.test.ts`
Expected: all green.

- [ ] **Step 5: Commit**

```sh
cd /Users/chancock/git/kaizen-official-plugins
git add plugins/llm-skills/new-skill.ts plugins/llm-skills/test/new-skill.test.ts
git commit -m "llm-skills: resolveTargetPath + assertNoCollision for new_skill"
```

---

## Task 9: Handler — atomic write + rescan + return shape

**Files:**
- Modify: `plugins/llm-skills/new-skill.ts` (add `composeSkillFile` + `makeNewSkillHandler`)
- Modify: `plugins/llm-skills/test/new-skill.test.ts` (handler tests against fake registry + tmp roots)

- [ ] **Step 1: Add failing handler tests**

Append to `plugins/llm-skills/test/new-skill.test.ts`:

```ts
import { readFile, stat as fsStat } from "node:fs/promises";
import { makeNewSkillHandler, composeSkillFile } from "../new-skill.ts";
import type { SkillsRegistryService } from "../public";

describe("composeSkillFile", () => {
  it("emits the canonical frontmatter + body shape", () => {
    const text = composeSkillFile({ name: "foo", description: "bar", body: "baz" });
    expect(text).toBe("---\nname: foo\ndescription: bar\n---\n\nbaz\n");
  });

  it("appends a trailing newline if the body does not already end with one", () => {
    const t1 = composeSkillFile({ name: "foo", description: "bar", body: "baz" });
    expect(t1.endsWith("\n")).toBe(true);
    const t2 = composeSkillFile({ name: "foo", description: "bar", body: "baz\n" });
    expect(t2.endsWith("baz\n")).toBe(true);
    expect(t2.endsWith("\n\n")).toBe(false);
  });
});

function fakeRegistry(opts: { listEntry?: { name: string; tokens?: number; baseDir?: string } } = {}): SkillsRegistryService & { rescanCalls: number } {
  let calls = 0;
  return {
    list: () => opts.listEntry ? [{ name: opts.listEntry.name, description: "d", tokens: opts.listEntry.tokens, baseDir: opts.listEntry.baseDir }] : [],
    load: async (n: string) => { throw new Error(`unknown skill: ${n}`); },
    register: () => () => {},
    rescan: async () => { calls++; return { changed: true, count: opts.listEntry ? 1 : 0 }; },
    get rescanCalls() { return calls; },
  } as any;
}

describe("makeNewSkillHandler", () => {
  async function makeRoots() {
    const projectRoot = await mkdtemp(join(tmpdir(), "ns-proj-"));
    const userRoot = await mkdtemp(join(tmpdir(), "ns-user-"));
    return { projectRoot, userRoot };
  }

  it("writes SKILL.md, rescans once, and returns { name, path, scope, tokens }", async () => {
    const { projectRoot, userRoot } = await makeRoots();
    const registry = fakeRegistry({ listEntry: { name: "git-rebase", tokens: 17, baseDir: join(projectRoot, "git-rebase") } });
    const handler = makeNewSkillHandler({ projectRoot, userRoot, registry });
    const result = await handler({
      name: "git-rebase",
      description: "How to rebase cleanly.",
      body: "Step 1.",
      scope: "project",
    }, { signal: new AbortController().signal, callId: "c1", log: () => {} });
    expect(result).toEqual({
      name: "git-rebase",
      path: join(projectRoot, "git-rebase", "SKILL.md"),
      scope: "project",
      tokens: 17,
    });
    expect(registry.rescanCalls).toBe(1);
    const written = await readFile(join(projectRoot, "git-rebase", "SKILL.md"), "utf8");
    expect(written).toBe("---\nname: git-rebase\ndescription: How to rebase cleanly.\n---\n\nStep 1.\n");
    await rm(projectRoot, { recursive: true });
    await rm(userRoot, { recursive: true });
  });

  it("writes under the user root when scope='user'", async () => {
    const { projectRoot, userRoot } = await makeRoots();
    const registry = fakeRegistry({ listEntry: { name: "foo", tokens: 5, baseDir: join(userRoot, "foo") } });
    const handler = makeNewSkillHandler({ projectRoot, userRoot, registry });
    const result = await handler({ name: "foo", description: "d", body: "b", scope: "user" }, { signal: new AbortController().signal, callId: "c", log: () => {} });
    expect((result as any).path).toBe(join(userRoot, "foo", "SKILL.md"));
    expect((result as any).scope).toBe("user");
    const exists = await fsStat(join(userRoot, "foo", "SKILL.md"));
    expect(exists.isFile()).toBe(true);
    await rm(projectRoot, { recursive: true });
    await rm(userRoot, { recursive: true });
  });

  it("creates the scope root if missing (mkdir -p)", async () => {
    const proj = await mkdtemp(join(tmpdir(), "ns-proj-"));
    const userRoot = join(proj, "nonexistent-user-root");   // does not exist yet
    const projectRoot = proj;
    const registry = fakeRegistry({ listEntry: { name: "x", tokens: 1, baseDir: join(userRoot, "x") } });
    const handler = makeNewSkillHandler({ projectRoot, userRoot, registry });
    await handler({ name: "x", description: "d", body: "b", scope: "user" }, { signal: new AbortController().signal, callId: "c", log: () => {} });
    const exists = await fsStat(join(userRoot, "x", "SKILL.md"));
    expect(exists.isFile()).toBe(true);
    await rm(proj, { recursive: true });
  });

  it("falls back to estimateTokens when rescan list does not surface tokens", async () => {
    const { projectRoot, userRoot } = await makeRoots();
    const registry: SkillsRegistryService = {
      list: () => [],   // empty even after rescan
      load: async () => { throw new Error("nope"); },
      register: () => () => {},
      rescan: async () => ({ changed: true, count: 0 }),
    } as any;
    const handler = makeNewSkillHandler({ projectRoot, userRoot, registry });
    const result = await handler({ name: "foo", description: "d", body: "abcd", scope: "user" }, { signal: new AbortController().signal, callId: "c", log: () => {} });
    // body 'abcd' → estimateTokens = ceil(4/4) = 1
    expect((result as any).tokens).toBe(1);
    await rm(projectRoot, { recursive: true });
    await rm(userRoot, { recursive: true });
  });

  it("throws and does not write on validation failure", async () => {
    const { projectRoot, userRoot } = await makeRoots();
    const registry = fakeRegistry();
    const handler = makeNewSkillHandler({ projectRoot, userRoot, registry });
    await expect(handler({ name: "Bad", description: "d", body: "b", scope: "user" }, { signal: new AbortController().signal, callId: "c", log: () => {} })).rejects.toThrow(/name must match/);
    // No directory created
    await expect(fsStat(join(userRoot, "Bad"))).rejects.toThrow();
    expect(registry.rescanCalls).toBe(0);
    await rm(projectRoot, { recursive: true });
    await rm(userRoot, { recursive: true });
  });

  it("throws and does not write on collision", async () => {
    const { projectRoot, userRoot } = await makeRoots();
    await mkdir(join(projectRoot, "exists"), { recursive: true });
    const registry = fakeRegistry();
    const handler = makeNewSkillHandler({ projectRoot, userRoot, registry });
    await expect(handler({ name: "exists", description: "d", body: "b", scope: "project" }, { signal: new AbortController().signal, callId: "c", log: () => {} })).rejects.toThrow(/already exists/);
    expect(registry.rescanCalls).toBe(0);
    await rm(projectRoot, { recursive: true });
    await rm(userRoot, { recursive: true });
  });

  it("wraps registry.rescan() errors with a message naming the written file", async () => {
    const { projectRoot, userRoot } = await makeRoots();
    const registry: SkillsRegistryService = {
      list: () => [],
      load: async () => { throw new Error("nope"); },
      register: () => () => {},
      rescan: async () => { throw new Error("disk broke"); },
    } as any;
    const handler = makeNewSkillHandler({ projectRoot, userRoot, registry });
    const expectedPath = join(projectRoot, "z", "SKILL.md");
    await expect(handler({ name: "z", description: "d", body: "b", scope: "project" }, { signal: new AbortController().signal, callId: "c", log: () => {} })).rejects.toThrow(new RegExp(`written to.*${expectedPath.replace(/\//g, "\\/")}`));
    // File was written despite the rescan failure.
    const exists = await fsStat(expectedPath);
    expect(exists.isFile()).toBe(true);
    await rm(projectRoot, { recursive: true });
    await rm(userRoot, { recursive: true });
  });

  it("uses write-then-rename so no SKILL.md.tmp-* file remains", async () => {
    const { projectRoot, userRoot } = await makeRoots();
    const registry = fakeRegistry({ listEntry: { name: "z", tokens: 2 } });
    const handler = makeNewSkillHandler({ projectRoot, userRoot, registry });
    await handler({ name: "z", description: "d", body: "b", scope: "project" }, { signal: new AbortController().signal, callId: "c", log: () => {} });
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(join(projectRoot, "z"));
    expect(entries).toEqual(["SKILL.md"]);
    await rm(projectRoot, { recursive: true });
    await rm(userRoot, { recursive: true });
  });
});
```

- [ ] **Step 2: Run the tests to confirm failure**

Run: `cd plugins/llm-skills && bun test test/new-skill.test.ts`
Expected: failure — `makeNewSkillHandler` and `composeSkillFile` not exported.

- [ ] **Step 3: Implement the handler in `new-skill.ts`**

Append to `plugins/llm-skills/new-skill.ts`:

```ts
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SkillsRegistryService } from "./public";
import { estimateTokens } from "./tokens.ts";

export interface ComposeSkillFileInput {
  name: string;
  description: string;
  body: string;
}

/**
 * Build the canonical SKILL.md file text. The frontmatter `name:` is
 * informational only — the path-derived name is canonical in the registry.
 */
export function composeSkillFile(input: ComposeSkillFileInput): string {
  const body = input.body.endsWith("\n") ? input.body : `${input.body}\n`;
  return `---\nname: ${input.name}\ndescription: ${input.description}\n---\n\n${body}`;
}

export interface MakeNewSkillHandlerDeps {
  projectRoot: string;
  userRoot: string;
  registry: SkillsRegistryService;
}

export type ToolHandlerFn = (
  args: unknown,
  ctx: { signal: AbortSignal; callId: string; turnId?: string; log: (m: string) => void },
) => Promise<unknown>;

export interface NewSkillResult {
  name: string;
  path: string;
  scope: "project" | "user";
  tokens: number;
}

/**
 * Build the new_skill handler. Pure factory; no module-scope state.
 *
 * Behaviour on success:
 *   1. Validate input (throws on violation).
 *   2. Resolve target path under the chosen scope's root.
 *   3. Refuse if anything exists at the target dir (lstat — does not follow symlinks).
 *   4. Compose SKILL.md text; mkdir -p the skill directory.
 *   5. Atomic write: writeFile to `SKILL.md.tmp-<pid>-<nonce>`, then rename to `SKILL.md`.
 *   6. await registry.rescan() — the registry's onChange callback fires the
 *      prompt-section bump and the skill:available-changed emit.
 *   7. Return { name, path, scope, tokens }, with tokens read from the freshly
 *      rescanned registry entry (heuristic fallback if absent).
 */
export function makeNewSkillHandler(deps: MakeNewSkillHandlerDeps): ToolHandlerFn {
  return async (args) => {
    validateNewSkillInput(args);

    const { name, description, body, scope } = args;

    const { baseDir, file } = resolveTargetPath({
      name,
      scope,
      projectRoot: deps.projectRoot,
      userRoot: deps.userRoot,
    });

    await mkdir(dirname(baseDir), { recursive: true });   // ensure scope root exists
    await assertNoCollision(baseDir);
    await mkdir(baseDir, { recursive: true });             // create skill dir

    const text = composeSkillFile({ name, description, body });
    const nonce = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
    const tmp = `${file}.tmp-${nonce}`;
    await writeFile(tmp, text, { encoding: "utf8", mode: 0o644 });
    await rename(tmp, file);

    try {
      await deps.registry.rescan();
    } catch (err: any) {
      throw new Error(
        `new_skill: SKILL.md was written to ${file} but registry rescan failed: ${err?.message ?? String(err)}. The skill will be picked up on the next turn:start.`,
      );
    }

    const entry = deps.registry.list().find(m => m.name === name);
    const tokens = typeof entry?.tokens === "number" ? entry.tokens : estimateTokens(body);

    const result: NewSkillResult = { name, path: file, scope, tokens };
    return result;
  };
}
```

- [ ] **Step 4: Run the handler tests**

Run: `cd plugins/llm-skills && bun test test/new-skill.test.ts`
Expected: all green.

- [ ] **Step 5: Commit**

```sh
cd /Users/chancock/git/kaizen-official-plugins
git add plugins/llm-skills/new-skill.ts plugins/llm-skills/test/new-skill.test.ts
git commit -m "llm-skills: makeNewSkillHandler — write SKILL.md atomically and rescan"
```

---

## Task 10: Wire `new_skill` into the plugin lifecycle

**Files:**
- Modify: `plugins/llm-skills/index.ts` (import + register + stop)
- Modify: `plugins/llm-skills/test/index.test.ts` (registration assertion)
- Modify: `plugins/llm-skills/test/integration.test.ts` (end-to-end through fake `tools:registry`)

- [ ] **Step 1: Add failing test in `index.test.ts`**

Append to `plugins/llm-skills/test/index.test.ts`:

```ts
describe("plugin setup — new_skill registered into tools:registry", () => {
  it("registers new_skill alongside load_skill when tools:registry is present", async () => {
    const registered: any[] = [];
    const toolsRegistry = {
      registerWith: (reg: any) => { registered.push(reg); return () => {}; },
      list: () => registered.map(r => r.schema),
      invoke: async () => undefined,
    };
    const ps = makePromptSystem();
    const { ctx } = makeCtx({
      env: { KAIZEN_LLM_SKILLS_PATH: join(FIXTURES, "ok-flat") },
      toolsRegistry,
      promptSystem: ps.service,
    });
    await plugin.setup(ctx);
    const names = registered.map(r => r.schema.name).sort();
    expect(names).toEqual(["load_skill", "new_skill"]);
    // Both registered with source kind 'skill'.
    expect(registered.every(r => r.source?.kind === "skill")).toBe(true);
  });

  it("unregisters new_skill on stop()", async () => {
    let unregCount = 0;
    const toolsRegistry = {
      registerWith: (_reg: any) => () => { unregCount++; },
      list: () => [],
      invoke: async () => undefined,
    };
    const ps = makePromptSystem();
    const { ctx } = makeCtx({
      env: { KAIZEN_LLM_SKILLS_PATH: join(FIXTURES, "ok-flat") },
      toolsRegistry,
      promptSystem: ps.service,
    });
    await plugin.setup(ctx);
    await plugin.stop!({} as any);
    // load_skill + new_skill = 2 unregister calls.
    expect(unregCount).toBe(2);
  });
});
```

- [ ] **Step 2: Run the test to confirm failure**

Run: `cd plugins/llm-skills && bun test test/index.test.ts`
Expected: the new `describe` block fails — `new_skill` not registered.

- [ ] **Step 3: Wire `new_skill` into `index.ts`**

In `plugins/llm-skills/index.ts`:

Add the import near the other tool imports:

```ts
import { NEW_SKILL_SCHEMA, makeNewSkillHandler } from "./new-skill.ts";
```

Add a module-scope cleanup handle next to the existing ones:

```ts
let unregisterNewSkill: (() => void) | undefined;
```

In the `if (tools)` block, **after** the existing `load_skill` registration, register `new_skill`:

```ts
if (tools) {
  const handler = makeLoadSkillHandler(registry, async (event, payload) => { await ctx.emit(event, payload); });
  unregisterTool = tools.registerWith({ schema: LOAD_SKILL_SCHEMA, handler, source: { kind: "skill" } });

  const newSkillHandler = makeNewSkillHandler({ projectRoot, userRoot, registry });
  unregisterNewSkill = tools.registerWith({
    schema: NEW_SKILL_SCHEMA,
    handler: newSkillHandler,
    source: { kind: "skill" },
  });
} else {
  ctx.log("[llm-skills] tools:registry not available; load_skill and new_skill not registered");
}
```

In `stop()`, drain the new handle alongside the others:

```ts
async stop() {
  try { unregisterTool?.(); } catch { /* idempotent */ }
  try { unregisterNewSkill?.(); } catch { /* idempotent */ }
  try { sectionHandle?.unregister(); } catch { /* idempotent */ }
  try { unregisterSlashCommands?.(); } catch { /* idempotent */ }
  unregisterTool = undefined;
  unregisterNewSkill = undefined;
  sectionHandle = undefined;
  unregisterSlashCommands = undefined;
},
```

- [ ] **Step 4: Add an integration smoke test in `integration.test.ts`**

Append to `plugins/llm-skills/test/integration.test.ts`:

```ts
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

describe("integration — new_skill end-to-end through fake tools:registry", () => {
  it("writes a SKILL.md, registers it, and load_skill returns its body", async () => {
    const userRoot = await mkdtemp(join(tmpdir(), "ns-user-"));
    const subscribers: Record<string, Function[]> = {};
    const emittedOrder: string[] = [];
    const emit = async (name: string, payload: unknown) => {
      emittedOrder.push(name);
      for (const fn of subscribers[name] ?? []) await fn(payload);
    };
    const tools = fakeToolsRegistry(emit);
    const ps = fakePromptSystem();

    const ctx: any = {
      cwd: "/does-not-exist",
      env: { KAIZEN_LLM_SKILLS_PATH: userRoot },
      log: mock(() => {}),
      defineEvent: () => {},
      on: (event: string, fn: Function) => { (subscribers[event] ??= []).push(fn); },
      emit,
      defineService: () => {},
      provideService: () => {},
      consumeService: () => {},
      useService: (name: string) => {
        if (name === "tools:registry") return tools;
        if (name === "prompt:registry") return ps.service;
        return undefined;
      },
      secrets: { get: async () => undefined, refresh: async () => undefined },
    };

    await plugin.setup(ctx);

    // 1. Call new_skill through the registry.
    const newResult = await tools.invoke("new_skill", {
      name: "demo",
      description: "Demo skill.",
      body: "Hello from the demo skill.",
      scope: "user",
    }, { signal: new AbortController().signal, callId: "c-new", log: () => {} }) as any;
    expect(newResult.name).toBe("demo");
    expect(newResult.scope).toBe("user");
    expect(newResult.path).toBe(join(userRoot, "demo", "SKILL.md"));
    expect(newResult.tokens).toBeGreaterThan(0);

    // 2. File is on disk.
    const fileText = await readFile(join(userRoot, "demo", "SKILL.md"), "utf8");
    expect(fileText).toContain("name: demo");
    expect(fileText).toContain("Hello from the demo skill.");

    // 3. load_skill now sees the new skill.
    const loadResult = await tools.invoke("load_skill", { name: "demo" }, {
      signal: new AbortController().signal, callId: "c-load", log: () => {},
    }) as any;
    expect(loadResult.body).toContain("Hello from the demo skill.");

    // 4. skill:available-changed emitted after the new_skill write (one for
    //    initial empty scan, one for the post-write rescan-change).
    const changeCount = emittedOrder.filter(n => n === "skill:available-changed").length;
    expect(changeCount).toBeGreaterThanOrEqual(2);

    await rm(userRoot, { recursive: true });
  });
});
```

- [ ] **Step 5: Run the full suite**

Run: `cd plugins/llm-skills && bun test`
Expected: all green.

- [ ] **Step 6: Commit**

```sh
cd /Users/chancock/git/kaizen-official-plugins
git add plugins/llm-skills/index.ts \
        plugins/llm-skills/test/index.test.ts \
        plugins/llm-skills/test/integration.test.ts
git commit -m "llm-skills: register new_skill into tools:registry"
```

---

## Task 11: Plugin validation

**Files:** none — verification step only.

- [ ] **Step 1: Run kaizen's plugin validator**

Run: `cd /Users/chancock/git/kaizen-official-plugins && kaizen plugin validate plugins/llm-skills`
Expected: no errors. If validator complains about manifest/permissions/`public.d.ts`, fix and re-run before continuing.

- [ ] **Step 2: Run the workspace-wide test sweep**

Run: `cd /Users/chancock/git/kaizen-official-plugins && bun test`
Expected: all green. Plugins consuming `skills:registry` (`claude-skills`, `llm-tool-approval` via name matching) do not import `SkillManifest.baseDir` semantics from `llm-skills`, so they should be unaffected, but the sweep catches surprises.

---

## Task 12: Update `CLAUDE.md` and `README.md` for `llm-skills`

**Files:**
- Modify: `plugins/llm-skills/CLAUDE.md`
- Modify: `plugins/llm-skills/README.md`

- [ ] **Step 1: Update the module map and invariants in `CLAUDE.md`**

In `plugins/llm-skills/CLAUDE.md`, in the "Module map" code block, add this line:

```
new-skill.ts      NEW_SKILL_SCHEMA, validateNewSkillInput, resolveTargetPath,
                  assertNoCollision, composeSkillFile, makeNewSkillHandler. Pure
                  factory + pure helpers; the handler is the only function that
                  touches the filesystem. Validates input, refuses on collision
                  (lstat — does not follow symlinks), writes SKILL.md via
                  write-then-rename, triggers a registry rescan, returns
                  { name, path, scope, tokens }.
```

In the "Boundaries" list, update the `scan.ts` bullet to:

```
- `scan.ts` is one of two modules that does filesystem I/O (the other is
  `new-skill.ts`, which only writes).
```

In the "Invariants" section, **replace** the existing "Editing scan behavior" paragraph's `SKILL.md`-related sentence with:

```
`scan.ts` is intentionally narrow: walk top-level subdirectories of each root,
read `<dir>/SKILL.md` only, derive name from the directory name. Cycles through
symlinks at the top level are accepted (the readFile will silently fail if the
target isn't a directory with a SKILL.md). Don't add a watcher (spec rules it
out — scan-on-turn-start is the model). Multi-file skill *writing* is owned by
the user (sibling files like `references/`, `scripts/` are left alone by the
scanner and never touched by `new_skill`).
```

Add a new invariant bullet under the existing list:

```
- **`new_skill` writes only SKILL.md.** Sibling files in the skill directory
  (`references/`, `scripts/`, anything else) are the user's concern. The tool
  refuses on collision via `lstat` so a partial scaffold the user is
  mid-authoring is not clobbered.
```

Update the "Local deploy" section to bump the version reference if the package's `version` field changes (this plan does not change the version; if you bump it during release, update the install dir path here).

- [ ] **Step 2: Update `README.md`**

In `plugins/llm-skills/README.md`, in the "What it does" section, replace this bullet:

```
- Scans two roots for `.md` files with frontmatter (`name`, `description`, optional `tokens`):
  - **Project:** `<cwd>/.kaizen/skills/`
  - **User:** `~/.kaizen/skills/`
  - Subdirectories namespace the skill: `python/poetry-deps.md` → `python/poetry-deps`.
```

with:

```
- Scans two roots for `<name>/SKILL.md` files (CC-style directory-per-skill layout):
  - **Project:** `<cwd>/.kaizen/skills/<name>/SKILL.md`
  - **User:** `~/.kaizen/skills/<name>/SKILL.md`
  - The directory name (`<name>`) is the registered skill name. Flat, single segment.
  - Sibling files in the skill directory (`references/`, `scripts/`, etc.) are left alone by the scanner — the LLM accesses them via filesystem tools using the manifest's `baseDir`.
  - Frontmatter required: `name`, `description`; optional: `tokens`.
```

In the "Provides" / "Tool" section, **after** the existing `load_skill` block, add:

````
**Tool** — `new_skill` (registered into `tools:registry` if available)

```jsonc
{
  "name": "new_skill",
  "parameters": {
    "type": "object",
    "properties": {
      "name":        { "type": "string" },
      "description": { "type": "string" },
      "body":        { "type": "string" },
      "scope":       { "type": "string", "enum": ["project", "user"] }
    },
    "required": ["name", "description", "body", "scope"],
    "additionalProperties": false
  },
  "tags": ["skills", "synthetic", "mutating"]
}
```

Creates a new skill at `<projectRoot|userRoot>/<name>/SKILL.md`. Validates name shape (`[a-z0-9][a-z0-9_-]*`, ≤64 chars), description (single-line, ≤200 chars, non-empty), and body (non-empty). Refuses on collision in the target scope (`lstat` — does not follow symlinks). After the write, triggers an immediate `rescan()` so the new skill is visible in the next turn's system prompt and immediately callable via `load_skill`. Returns `{ name, path, scope, tokens }`.

Routes through `llm-tool-approval` like any other mutating tool — the default `llm-skills:*` allow rule does not match the bare name `new_skill`, so the gate prompts by default. "Approve Always" persists the rule to the project's approval config.
````

In the "Permissions" section, **replace**:

```
`tier: unscoped` — reads files under `~/.kaizen/skills/` and `<project>/.kaizen/skills/`. No writes, no process execution, no network.
```

with:

```
`tier: unscoped` — reads and writes files under `~/.kaizen/skills/` and `<project>/.kaizen/skills/` (writes only via the `new_skill` tool, which routes through `llm-tool-approval`). No process execution, no network.
```

- [ ] **Step 3: Commit**

```sh
cd /Users/chancock/git/kaizen-official-plugins
git add plugins/llm-skills/CLAUDE.md plugins/llm-skills/README.md
git commit -m "llm-skills: docs for new_skill tool and CC layout"
```

---

## Task 13: Local deploy + smoke

This task uses the deploy flow from `plugins/llm-skills/CLAUDE.md`. It puts the rebuilt plugin into the kaizen install directory so the local harness picks it up.

**Files:** none modified in-repo.

- [ ] **Step 1: Bundle and sync**

```sh
cd /Users/chancock/git/kaizen-official-plugins
PLUGIN=llm-skills
VERSION=$(jq -r .version plugins/$PLUGIN/package.json)
INSTALL_DIR=~/.kaizen/marketplaces/official/plugins/${PLUGIN}@${VERSION}
mkdir -p "$INSTALL_DIR/dist"
(cd plugins/$PLUGIN && bun build --target=bun --outfile=dist/index.js index.ts)
cp plugins/$PLUGIN/dist/index.js "$INSTALL_DIR/dist/index.js"
rsync -a --exclude='node_modules' --exclude='dist' plugins/$PLUGIN/ "$INSTALL_DIR/"
```

Expected: no errors. `$INSTALL_DIR/dist/index.js` exists and was just rebuilt.

- [ ] **Step 2: Verify the installed bundle has the new schema**

Run: `grep -c '"new_skill"' "$INSTALL_DIR/dist/index.js"`
Expected: count ≥ 1.

- [ ] **Step 3: Smoke test in the local harness**

Run: `cd /Users/chancock/git/kaizen-official-plugins && kaizen --harness ./harnesses/local.json` (or whichever harness is in active use).

Inside the harness:

1. Run `/skills:list`. Existing project / user skills should appear (note: any pre-existing flat `<name>.md` files no longer appear).
2. Have the LLM call `new_skill` with a real-ish skill (e.g. `name: smoke-test`, `description: "Smoke-test skill."`, `body: "Hello."`, `scope: "user"`). The approval gate should prompt; Approve Once.
3. Run `/skills:list` again — `smoke-test` should appear with source `user` and a path under `~/.kaizen/skills/smoke-test/SKILL.md`.
4. Run `/skills:get smoke-test` — header should show `Source: user`, `Path: ~/.kaizen/skills/smoke-test`, tokens, and the body.
5. Have the LLM `load_skill smoke-test` — body should come back with the `Base directory for this skill:` preamble (because `baseDir` is now set).
6. Have the LLM call `new_skill` with the same name again — should fail with "skill already exists at ...".
7. Quit the harness, then `rm -rf ~/.kaizen/skills/smoke-test/` to clean up.

- [ ] **Step 4: No commit needed — the install dir is outside the repo.**

---

## Self-Review

Run through this checklist after writing the plan:

**Spec coverage** — each spec section maps to one or more tasks:
- Architecture: layout change → Task 2; new-skill.ts module → Tasks 6, 7, 8, 9; reconciliation refactor → Tasks 4, 5.
- Tool surface (schema + return shape) → Tasks 6, 9.
- Approval → covered structurally (no code change needed beyond using the existing tools:registry surface); smoke step 2 in Task 13 verifies the prompt fires.
- Validation table → Task 7.
- Error handling → Tasks 7 (validation), 8 (collision/lstat), 9 (atomic write, fallback tokens).
- Testing list → distributed across Tasks 2, 3, 4, 6–10.
- Local deploy → Task 13.

**Placeholder scan** — no TBDs, no "TODO" steps, every code block is complete.

**Type consistency** — `NewSkillInput.scope: "project" | "user"` matches `ResolveTargetPathArgs.scope` matches the JSON schema `enum`. `NewSkillResult` fields match the schema and the return-shape tests. `RegistryDeps.onChange?: (info?: { count: number }) => void` matches the call sites in both `registry.rescan()` and `index.ts`.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-23-new-skill-tool.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
