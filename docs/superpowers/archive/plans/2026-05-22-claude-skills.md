# claude-skills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Claude Code's on-disk skills (user, project, plugin-cache) available to the `local` harness via `skills:registry`, with CC's `Base directory for this skill:` preamble emitted by `llm-skills`'s `load_skill` handler.

**Architecture:** Add optional `baseDir?: string` to the `SkillManifest` contract in `llm-contracts`. Have `llm-skills`'s `load_skill` handler prepend the preamble line when `baseDir` is set. Create a new `claude-skills` plugin that scans the three CC roots, parses `SKILL.md` frontmatter, and registers entries programmatically with `skills:registry`. claude-skills owns its own throttled `turn:start` rescan loop and reads its rescan interval through `config:store`.

**Tech Stack:** Bun workspace monorepo, TypeScript, kaizen `apiVersion: "3.0.0"`. Tests via `bun:test`. Contracts in `llm-contracts`. Service wiring via `consumeService` / `useService` / `provideService`.

**Spec:** `docs/superpowers/specs/2026-05-22-claude-skills-design.md`

---

## Pre-flight

Read these before starting:

- `docs/PLUGIN_ARCHITECTURE.md` — service ownership rules, contract conventions, hard vs topo-hint vs deferred dependencies. Non-negotiable for service wiring.
- `docs/superpowers/specs/2026-05-22-claude-skills-design.md` — the spec this plan implements.
- `plugins/llm-skills/CLAUDE.md` — module boundaries and invariants the existing skills plugin enforces. claude-skills mirrors its structure.
- `plugins/llm-tavily-search/index.ts` — canonical example of consuming `config:store` (we mirror this pattern).
- `plugins/llm-contracts/CLAUDE.md` — how to add/extend a contract. We only modify an existing contract (additive optional field), so most of that doc is FYI.

All commits in this plan go directly to `main`. Skip the `document-and-commit` skill (it's TaxHawk-specific). No `Co-Authored-By` lines.

---

## Task 1: Extend SkillManifest with optional baseDir

**Files:**
- Modify: `plugins/llm-contracts/contracts/skills-registry.ts`

- [ ] **Step 1: Add the `baseDir` field to `SkillManifest`**

Edit `plugins/llm-contracts/contracts/skills-registry.ts`:

```typescript
export interface SkillManifest {
  name: string;
  description: string;
  /** Cached estimate, in tokens, used by budgeting code. */
  tokens?: number;
  /** Absolute filesystem path to the skill's root directory, when the skill has one.
   *  When set, llm-skills' load_skill handler prepends "Base directory for this skill: <baseDir>\n\n"
   *  to the returned body so the LLM can resolve relative references inside the skill body. */
  baseDir?: string;
}
```

Nothing else in this file changes.

- [ ] **Step 2: Run llm-contracts tests to verify nothing broke**

Run: `cd plugins/llm-contracts && bun test`
Expected: PASS (all existing tests).

- [ ] **Step 3: Bump llm-contracts version**

Edit `plugins/llm-contracts/package.json`, bump `"version"` from its current value to the next minor (e.g., `0.4.0` → `0.5.0`).

- [ ] **Step 4: Local-deploy llm-contracts**

Per `plugins/llm-contracts/CLAUDE.md`:

```bash
PLUGIN=llm-contracts
VERSION=$(jq -r .version plugins/$PLUGIN/package.json)
INSTALL_DIR=~/.kaizen/marketplaces/official/plugins/${PLUGIN}@${VERSION}
(cd plugins/$PLUGIN && bun build --target=bun --outfile=dist/index.js index.ts)
mkdir -p "$INSTALL_DIR/dist"
cp plugins/$PLUGIN/dist/index.js "$INSTALL_DIR/dist/index.js"
rsync -a --exclude='node_modules' --exclude='dist' plugins/$PLUGIN/ "$INSTALL_DIR/"
```

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-contracts/contracts/skills-registry.ts plugins/llm-contracts/package.json
git commit -m "llm-contracts: add optional baseDir to SkillManifest

Additive, back-compat. llm-skills' load_skill handler will use this to
prepend 'Base directory for this skill: <path>' when set, matching CC's
own format for skill loads. Existing file-backed skills leave baseDir
unset and are unaffected."
```

---

## Task 2: llm-skills load_skill prepends preamble when baseDir is set

**Files:**
- Modify: `plugins/llm-skills/tool.ts`
- Modify: `plugins/llm-skills/test/tool.test.ts`

- [ ] **Step 1: Write the failing tests first**

Open `plugins/llm-skills/test/tool.test.ts` and add three cases. The file already exercises `makeLoadSkillHandler`. Append (or merge into existing `describe` block) these tests. Use the same `mock` / fake-registry idiom the file already uses — if you're unsure, read the existing tests in that file first and follow their pattern.

```typescript
describe("makeLoadSkillHandler — baseDir preamble", () => {
  it("prepends 'Base directory for this skill:' line when manifest.baseDir is set", async () => {
    const registry = {
      list: () => [{ name: "alpha", description: "d", tokens: 10, baseDir: "/abs/skills/alpha" }],
      load: async () => "BODY",
      register: () => () => {},
      rescan: async () => ({ changed: false, count: 0 }),
    };
    const emit = mock(async () => {});
    const handler = makeLoadSkillHandler(registry, emit);
    const result = await handler({ name: "alpha" }, { signal: new AbortController().signal, callId: "c1", log: () => {} }) as { body: string };
    expect(result.body).toBe("Base directory for this skill: /abs/skills/alpha\n\nBODY");
  });

  it("returns body verbatim when manifest.baseDir is unset", async () => {
    const registry = {
      list: () => [{ name: "alpha", description: "d", tokens: 10 }],
      load: async () => "BODY",
      register: () => () => {},
      rescan: async () => ({ changed: false, count: 0 }),
    };
    const handler = makeLoadSkillHandler(registry, async () => {});
    const result = await handler({ name: "alpha" }, { signal: new AbortController().signal, callId: "c1", log: () => {} }) as { body: string };
    expect(result.body).toBe("BODY");
  });

  it("treats an empty-string baseDir as unset (no preamble)", async () => {
    const registry = {
      list: () => [{ name: "alpha", description: "d", tokens: 10, baseDir: "" }],
      load: async () => "BODY",
      register: () => () => {},
      rescan: async () => ({ changed: false, count: 0 }),
    };
    const handler = makeLoadSkillHandler(registry, async () => {});
    const result = await handler({ name: "alpha" }, { signal: new AbortController().signal, callId: "c1", log: () => {} }) as { body: string };
    expect(result.body).toBe("BODY");
  });
});
```

If the existing file doesn't already import `mock`, add `mock` to the `bun:test` import.

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `cd plugins/llm-skills && bun test tool.test.ts`
Expected: 3 new failures with messages about the body not having the preamble (or vice versa).

- [ ] **Step 3: Implement the preamble logic in `tool.ts`**

Edit `plugins/llm-skills/tool.ts`. Replace the body of `makeLoadSkillHandler`'s returned function with:

```typescript
  return async (args) => {
    if (typeof args !== "object" || args === null) {
      throw new Error("load_skill: args must be an object with a 'name' string");
    }
    const name = (args as { name?: unknown }).name;
    if (typeof name !== "string" || name.length === 0) {
      throw new Error("load_skill: 'name' is required and must be a non-empty string");
    }
    const body = await registry.load(name);
    const fromList = registry.list().find(m => m.name === name);
    const tokens = typeof fromList?.tokens === "number" ? fromList.tokens : estimateTokens(body);
    const baseDir = typeof fromList?.baseDir === "string" && fromList.baseDir.length > 0 ? fromList.baseDir : undefined;
    const finalBody = baseDir ? `Base directory for this skill: ${baseDir}\n\n${body}` : body;
    await emit("skill:loaded", { name, tokens });
    return { name, tokens, body: finalBody };
  };
```

- [ ] **Step 4: Run llm-skills test suite**

Run: `cd plugins/llm-skills && bun test`
Expected: PASS — all existing tests still pass, plus the three new ones.

- [ ] **Step 5: Bump llm-skills version**

Edit `plugins/llm-skills/package.json`, bump `"version"` from `0.1.2` to `0.1.3` (or next minor — match the existing cadence; the spec says "minor bump" but the existing cadence is patch-bump-per-feature).

- [ ] **Step 6: Local-deploy llm-skills**

Per `plugins/llm-skills/CLAUDE.md`:

```bash
PLUGIN=llm-skills
VERSION=$(jq -r .version plugins/$PLUGIN/package.json)
INSTALL_DIR=~/.kaizen/marketplaces/official/plugins/${PLUGIN}@${VERSION}
(cd plugins/$PLUGIN && bun build --target=bun --outfile=dist/index.js index.ts)
mkdir -p "$INSTALL_DIR/dist"
cp plugins/$PLUGIN/dist/index.js "$INSTALL_DIR/dist/index.js"
rsync -a --exclude='node_modules' --exclude='dist' plugins/$PLUGIN/ "$INSTALL_DIR/"
```

- [ ] **Step 7: Commit**

```bash
git add plugins/llm-skills/tool.ts plugins/llm-skills/test/tool.test.ts plugins/llm-skills/package.json
git commit -m "llm-skills: load_skill prepends 'Base directory' line when baseDir set

Matches Claude Code's own format for skill loads. Existing file-backed
skills leave manifest.baseDir unset and get the body verbatim. The
preamble is keyed off the manifest, so programmatic registrations (e.g.
the upcoming claude-skills shim) get it free by setting one optional
field on the manifest they pass to register()."
```

---

## Task 3: Scaffold claude-skills plugin

**Files:**
- Create: `plugins/claude-skills/package.json`
- Create: `plugins/claude-skills/tsconfig.json`
- Create: `plugins/claude-skills/public.d.ts`
- Create: `plugins/claude-skills/README.md`
- Create: `plugins/claude-skills/CLAUDE.md`
- Create: `plugins/claude-skills/index.ts` (skeleton — fleshed out in Task 8)
- Create: `plugins/claude-skills/.kaizen/.gitkeep`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "claude-skills",
  "version": "0.1.0",
  "description": "Shim Claude Code skills (user, project, plugin-cache layouts) into skills:registry for the local harness.",
  "type": "module",
  "exports": {
    ".": "./index.ts",
    "./public": "./public.d.ts"
  },
  "keywords": ["kaizen-plugin"],
  "dependencies": {
    "llm-contracts": "workspace:*"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "^5.4.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

Copy from `plugins/llm-skills/tsconfig.json`. Run:

```bash
cp plugins/llm-skills/tsconfig.json plugins/claude-skills/tsconfig.json
```

- [ ] **Step 3: Create `public.d.ts`**

```typescript
// claude-skills public surface.
// This plugin provides no contract services and exports no types.
export {};
```

- [ ] **Step 4: Create `index.ts` (skeleton)**

```typescript
import type { KaizenPlugin } from "kaizen/types";

const plugin: KaizenPlugin = {
  name: "claude-skills",
  apiVersion: "3.0.0",
  permissions: { tier: "unscoped" },
  services: { consumes: ["skills:registry", "config:store"] },

  async setup(ctx) {
    ctx.consumeService("skills:registry");
    ctx.consumeService("config:store");
    // Lifecycle fleshed out in Task 8.
  },

  async stop() {
    // Drained in Task 8.
  },
};

export default plugin;
```

- [ ] **Step 5: Create `README.md`**

```markdown
# claude-skills

Shim Claude Code's on-disk skills into the local harness's `skills:registry`.

## What it does

Scans the three CC skill discovery roots and registers each `SKILL.md` programmatically with `skills:registry`:

- Project: `<cwd>/.claude/skills/<name>/SKILL.md` → registered as `<name>`
- User: `~/.claude/skills/<name>/SKILL.md` → registered as `<name>`
- Plugin cache: `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/skills/<name>/SKILL.md` → registered as `<plugin>:<name>` (lex-highest version wins per plugin)

Cross-layer precedence: project > user > plugin-cache.

Each registered manifest carries `baseDir` (absolute path to the skill's directory). `llm-skills`'s `load_skill` handler uses this to prepend `Base directory for this skill: <baseDir>` to the returned body, matching CC's own load behavior so the LLM can resolve relative references like `references/foo.md`.

## Refresh

Throttled rescan on `turn:start`. Interval is configurable via `config:store`:

| Key | Default | Env | Where |
|---|---|---|---|
| `rescanIntervalMs` | 30000 | `KAIZEN_CLAUDE_SKILLS_RESCAN_MS` | `/config:set claude-skills rescanIntervalMs=<ms>` |

Live updates from `config:store` are honored on the next rescan.

## Wiring

### Consumes (both hard)

- `skills:registry` — no value without it; declared in `services.consumes` + `consumeService` + `useService`.
- `config:store` — same.

### Provides

Nothing. This plugin is a pure consumer/shim.

## Permissions

`tier: unscoped` — reads under `~/.claude/` and `<cwd>/.claude/`. No writes, no process execution, no network.

## Limits

- No FS watching; rescans are poll-on-`turn:start`.
- Plugin-cache version dedup is lexicographic (`2.0.0` beats `1.10.0` — be aware if your version strings break semver-as-lex).
- Skill bodies are read verbatim from `SKILL.md`; sibling files (`references/`, `scripts/`) are not surfaced through this plugin. The LLM accesses them via existing filesystem tools, using `baseDir` to anchor relative paths.
```

- [ ] **Step 6: Create `CLAUDE.md`**

```markdown
# Working in `claude-skills`

Notes for agents editing this plugin. See `README.md` for the user-facing contract.

## Module map

```
index.ts          Plugin lifecycle: resolves roots, registers config schema,
                  consumes skills:registry, runs initial scan + registrations,
                  subscribes to turn:start for throttled rescans, drains
                  registrations on stop(). Only file that touches `ctx`.
scan.ts           scanRoots({ projectRoot, userRoot, pluginCacheRoot })
                  → ScannedSkill[]. Pure I/O. Walks the three layouts. Names:
                    project/user → <dir>
                    plugin-cache → <plugin>:<dir>
                  Symlink cycle guard via realpath set. Plugin-cache dedup by
                  lex-highest version per <plugin>:<dir>.
frontmatter.ts    parseFrontmatter(text) → { ok, manifest, body } | { ok: false, error }.
                  Hand-rolled YAML-ish parser. Honors name/description/tokens;
                  silently ignores other keys (including CC's `allowed-tools`).
registrar.ts      reconcile(registry, currentScan, previousSnapshot) → newSnapshot.
                  Pure logic. Diffs by name → contentHash. Calls register/unregister
                  for adds, removes, hash-changes.
hash.ts           contentHash(body) → string. SHA-1 hex.
public.d.ts       Empty.
```

Boundaries:
- Only `index.ts` imports `kaizen/types` or touches `ctx`.
- Only `scan.ts` performs filesystem I/O.
- Only `registrar.ts` is stateful (holds the previous snapshot).
- Tests live under `test/` per module. Run with `bun test`.

## Invariants

- **Hard deps:** `skills:registry` and `config:store` are both declared in `services.consumes` AND backed by `consumeService` AND used via `useService`. If either is missing, the plugin refuses to boot. Both are correct — claude-skills has zero value without them.
- **Programmatic-layer ordering:** plugin-cache registers first, then user, then project. Later writers overwrite earlier in `skills:registry`'s programmatic map, which matches the documented precedence (project > user > plugin-cache).
- **Scan never throws.** Bad frontmatter, unreadable files, duplicate-within-layer all skip the offender and emit `harness:error`.
- **Reconcile is hash-keyed.** A skill whose body hasn't changed between scans isn't unregistered/re-registered (would churn `llm-skills`'s prompt-section generation).
- **`baseDir` is always set and always absolute.** It's the realpath of the directory containing the `SKILL.md`.
- **Stop is idempotent.** All unregister calls wrapped in `try`/`catch`. Re-stops are no-ops.

## Local deploy

```bash
PLUGIN=claude-skills
VERSION=$(jq -r .version plugins/$PLUGIN/package.json)
INSTALL_DIR=~/.kaizen/marketplaces/official/plugins/${PLUGIN}@${VERSION}
(cd plugins/$PLUGIN && bun build --target=bun --outfile=dist/index.js index.ts)
mkdir -p "$INSTALL_DIR/dist"
cp plugins/$PLUGIN/dist/index.js "$INSTALL_DIR/dist/index.js"
rsync -a --exclude='node_modules' --exclude='dist' plugins/$PLUGIN/ "$INSTALL_DIR/"
```
```

- [ ] **Step 7: Create `.kaizen/.gitkeep`**

```bash
mkdir -p plugins/claude-skills/.kaizen
touch plugins/claude-skills/.kaizen/.gitkeep
```

- [ ] **Step 8: Install workspace deps**

```bash
bun install
```

Expected: bun resolves `claude-skills` into the workspace; no errors.

- [ ] **Step 9: Validate the plugin manifest scaffolds correctly**

Run: `kaizen plugin validate plugins/claude-skills`
Expected: PASS (or, at worst, fails only on "no skills/agents/commands/etc." style warnings, not on manifest structure).

- [ ] **Step 10: Commit**

```bash
git add plugins/claude-skills
git commit -m "claude-skills: scaffold plugin skeleton

New consumer plugin that will shim Claude Code skills into skills:registry.
Lifecycle is empty here; modules fleshed out in subsequent commits.

Declares hard deps on skills:registry and config:store. tier: unscoped
(reads under ~/.claude/ and <cwd>/.claude/, outside the scoped allowlists)."
```

---

## Task 4: Implement hash.ts

**Files:**
- Create: `plugins/claude-skills/hash.ts`
- Create: `plugins/claude-skills/test/hash.test.ts`

- [ ] **Step 1: Write the failing test**

Create `plugins/claude-skills/test/hash.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import { contentHash } from "../hash.ts";

describe("contentHash", () => {
  it("returns the same hash for identical input", () => {
    expect(contentHash("hello world")).toBe(contentHash("hello world"));
  });

  it("returns different hashes for different input", () => {
    expect(contentHash("hello world")).not.toBe(contentHash("hello worl"));
  });

  it("returns a hex string", () => {
    expect(contentHash("anything")).toMatch(/^[0-9a-f]+$/);
  });

  it("handles empty input", () => {
    expect(contentHash("")).toMatch(/^[0-9a-f]+$/);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `cd plugins/claude-skills && bun test test/hash.test.ts`
Expected: FAIL — `cannot find module ../hash.ts`.

- [ ] **Step 3: Implement `hash.ts`**

```typescript
import { createHash } from "node:crypto";

export function contentHash(body: string): string {
  return createHash("sha1").update(body, "utf8").digest("hex");
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `cd plugins/claude-skills && bun test test/hash.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/claude-skills/hash.ts plugins/claude-skills/test/hash.test.ts
git commit -m "claude-skills: add contentHash helper

SHA-1 hex of body bytes. Used by registrar.ts to detect changed skills
between rescans without diffing full bodies."
```

---

## Task 5: Implement frontmatter.ts

**Files:**
- Create: `plugins/claude-skills/frontmatter.ts`
- Create: `plugins/claude-skills/test/frontmatter.test.ts`

`plugins/llm-skills/frontmatter.ts` already exists and has the same shape we want. Read it first to understand the parser contract. We're going to copy its approach (not the file — we want claude-skills to be independent) and adapt only as needed.

- [ ] **Step 1: Write the failing tests**

Create `plugins/claude-skills/test/frontmatter.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import { parseFrontmatter } from "../frontmatter.ts";

describe("parseFrontmatter", () => {
  it("parses a minimal valid skill", () => {
    const text = "---\nname: foo\ndescription: A foo skill\n---\nBODY";
    const r = parseFrontmatter(text);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manifest.name).toBe("foo");
      expect(r.manifest.description).toBe("A foo skill");
      expect(r.body).toBe("BODY");
    }
  });

  it("strips balanced quotes from values", () => {
    const text = `---\nname: "foo"\ndescription: 'A foo skill'\n---\nBODY`;
    const r = parseFrontmatter(text);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manifest.name).toBe("foo");
      expect(r.manifest.description).toBe("A foo skill");
    }
  });

  it("honors an explicit tokens override", () => {
    const text = "---\nname: foo\ndescription: d\ntokens: 1234\n---\nBODY";
    const r = parseFrontmatter(text);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.manifest.tokens).toBe(1234);
  });

  it("silently ignores unknown keys (allowed-tools, etc.)", () => {
    const text = "---\nname: foo\ndescription: d\nallowed-tools: [Bash, Read]\ncolor: red\n---\nBODY";
    const r = parseFrontmatter(text);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manifest.name).toBe("foo");
      expect(r.manifest.description).toBe("d");
    }
  });

  it("rejects missing name", () => {
    const text = "---\ndescription: d\n---\nBODY";
    const r = parseFrontmatter(text);
    expect(r.ok).toBe(false);
  });

  it("rejects missing description", () => {
    const text = "---\nname: foo\n---\nBODY";
    const r = parseFrontmatter(text);
    expect(r.ok).toBe(false);
  });

  it("rejects an unclosed frontmatter block", () => {
    const text = "---\nname: foo\ndescription: d\nBODY";
    const r = parseFrontmatter(text);
    expect(r.ok).toBe(false);
  });

  it("rejects a body with no frontmatter", () => {
    const text = "BODY only, no frontmatter";
    const r = parseFrontmatter(text);
    expect(r.ok).toBe(false);
  });

  it("ignores a leading BOM and trailing whitespace", () => {
    const text = "﻿---\nname: foo\ndescription: d\n---\nBODY  \n";
    const r = parseFrontmatter(text);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.body.trimEnd()).toBe("BODY");
  });
});
```

- [ ] **Step 2: Run tests to verify failures**

Run: `cd plugins/claude-skills && bun test test/frontmatter.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `frontmatter.ts`**

```typescript
export interface ParsedManifest {
  name: string;
  description: string;
  tokens?: number;
}

export type ParseResult =
  | { ok: true; manifest: ParsedManifest; body: string }
  | { ok: false; error: string };

const HONORED_KEYS = new Set(["name", "description", "tokens"]);

export function parseFrontmatter(text: string): ParseResult {
  let src = text;
  if (src.charCodeAt(0) === 0xFEFF) src = src.slice(1);

  if (!src.startsWith("---\n") && src !== "---") {
    return { ok: false, error: "missing opening '---' delimiter" };
  }

  const afterOpen = src.slice(4); // past "---\n"
  // Closing delimiter: a line that is exactly "---", followed by either newline or EOF.
  const closeMatch = afterOpen.match(/^---(\n|$)/m);
  if (!closeMatch || closeMatch.index === undefined) {
    return { ok: false, error: "missing closing '---' delimiter" };
  }
  const headerText = afterOpen.slice(0, closeMatch.index);
  const body = afterOpen.slice(closeMatch.index + closeMatch[0].length);

  const raw: Record<string, string> = {};
  for (const line of headerText.split("\n")) {
    if (line.trim() === "") continue;
    const m = line.match(/^([A-Za-z_-][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!m) return { ok: false, error: `unparseable frontmatter line: ${JSON.stringify(line)}` };
    const key = m[1]!;
    let val = m[2] ?? "";
    if (val.includes("\n")) return { ok: false, error: `multi-line values not supported: ${key}` };
    // Strip balanced quotes.
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    raw[key] = val.trim();
  }

  if (!raw.name) return { ok: false, error: "missing required field: name" };
  if (!raw.description) return { ok: false, error: "missing required field: description" };

  const manifest: ParsedManifest = { name: raw.name, description: raw.description };
  if (raw.tokens) {
    const n = parseInt(raw.tokens, 10);
    if (Number.isFinite(n) && n > 0) manifest.tokens = n;
  }
  // Other keys silently ignored (HONORED_KEYS is informational here; we just don't read them).
  void HONORED_KEYS;

  return { ok: true, manifest, body };
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd plugins/claude-skills && bun test test/frontmatter.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/claude-skills/frontmatter.ts plugins/claude-skills/test/frontmatter.test.ts
git commit -m "claude-skills: add frontmatter parser

Hand-rolled YAML-ish parser, same shape as llm-skills/frontmatter.ts:
honors name/description/tokens, silently ignores other keys (including
CC's allowed-tools, color, etc.). No YAML dep."
```

---

## Task 6: Implement scan.ts + fixtures

**Files:**
- Create: `plugins/claude-skills/scan.ts`
- Create: `plugins/claude-skills/test/scan.test.ts`
- Create: `plugins/claude-skills/test/fixtures/three-roots/...`
- Create: `plugins/claude-skills/test/fixtures/bad-frontmatter/...`

- [ ] **Step 1: Build the fixture trees**

```bash
cd plugins/claude-skills

mkdir -p test/fixtures/three-roots/project/.claude/skills/proj-only
mkdir -p test/fixtures/three-roots/project/.claude/skills/shared
mkdir -p test/fixtures/three-roots/user/.claude/skills/user-only
mkdir -p test/fixtures/three-roots/user/.claude/skills/shared
mkdir -p test/fixtures/three-roots/cache/mp1/plug-a/1.0.0/skills/cached-a
mkdir -p test/fixtures/three-roots/cache/mp1/plug-a/2.0.0/skills/cached-a
mkdir -p test/fixtures/three-roots/cache/mp1/plug-b/1.0.0/skills/cached-b
mkdir -p test/fixtures/three-roots/cache/mp1/plug-c/1.0.0/skills/orphan-no-skill
mkdir -p test/fixtures/bad-frontmatter/user/.claude/skills/broken
mkdir -p test/fixtures/bad-frontmatter/user/.claude/skills/no-desc
```

Now write fixture SKILL.md files. Use these exact contents:

`test/fixtures/three-roots/project/.claude/skills/proj-only/SKILL.md`:
```
---
name: proj-only
description: A project-only skill
---
PROJ ONLY BODY
```

`test/fixtures/three-roots/project/.claude/skills/shared/SKILL.md`:
```
---
name: shared
description: shared — project layer
---
PROJECT WINS
```

`test/fixtures/three-roots/user/.claude/skills/user-only/SKILL.md`:
```
---
name: user-only
description: A user-only skill
---
USER ONLY BODY
```

`test/fixtures/three-roots/user/.claude/skills/shared/SKILL.md`:
```
---
name: shared
description: shared — user layer (masked)
---
USER MASKED
```

`test/fixtures/three-roots/cache/mp1/plug-a/1.0.0/skills/cached-a/SKILL.md`:
```
---
name: cached-a
description: cached-a v1
---
OLD VERSION
```

`test/fixtures/three-roots/cache/mp1/plug-a/2.0.0/skills/cached-a/SKILL.md`:
```
---
name: cached-a
description: cached-a v2
---
NEW VERSION
```

`test/fixtures/three-roots/cache/mp1/plug-b/1.0.0/skills/cached-b/SKILL.md`:
```
---
name: cached-b
description: a plug-b skill
---
PLUG-B BODY
```

(`test/fixtures/three-roots/cache/mp1/plug-c/1.0.0/skills/orphan-no-skill/` deliberately has no SKILL.md — touch an empty `.gitkeep` so git tracks the dir.)

```bash
touch test/fixtures/three-roots/cache/mp1/plug-c/1.0.0/skills/orphan-no-skill/.gitkeep
```

`test/fixtures/bad-frontmatter/user/.claude/skills/broken/SKILL.md`:
```
---
name: broken
description: unclosed delimiter — no closing dashes
BODY
```

`test/fixtures/bad-frontmatter/user/.claude/skills/no-desc/SKILL.md`:
```
---
name: no-desc
---
BODY (no description)
```

- [ ] **Step 2: Write the failing tests**

Create `plugins/claude-skills/test/scan.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { scanRoots, type ScannedSkill } from "../scan.ts";

const F = join(import.meta.dir, "fixtures");

function byName(skills: ScannedSkill[]): Record<string, ScannedSkill> {
  const out: Record<string, ScannedSkill> = {};
  for (const s of skills) out[s.name] = s;
  return out;
}

describe("scanRoots — three-roots fixture", () => {
  const projectRoot = join(F, "three-roots/project/.claude/skills");
  const userRoot = join(F, "three-roots/user/.claude/skills");
  const pluginCacheRoot = join(F, "three-roots/cache");

  it("discovers expected skills across all three layers with correct names", async () => {
    const errors: string[] = [];
    const logs: string[] = [];
    const result = await scanRoots({ projectRoot, userRoot, pluginCacheRoot }, {
      onError: (m) => errors.push(m),
      log: (m) => logs.push(m),
    });
    const idx = byName(result);
    expect(Object.keys(idx).sort()).toEqual(
      ["proj-only", "shared", "user-only", "plug-a:cached-a", "plug-b:cached-b"].sort(),
    );
  });

  it("derives 'shared' from the project layer, not user (project wins)", async () => {
    const result = await scanRoots({ projectRoot, userRoot, pluginCacheRoot }, { onError: () => {}, log: () => {} });
    const idx = byName(result);
    expect(idx["shared"]!.body).toBe("PROJECT WINS\n");
  });

  it("picks the lexicographically-highest version for a plugin-cache skill", async () => {
    const logs: string[] = [];
    const result = await scanRoots({ projectRoot, userRoot, pluginCacheRoot }, { onError: () => {}, log: (m) => logs.push(m) });
    const idx = byName(result);
    expect(idx["plug-a:cached-a"]!.body).toBe("NEW VERSION\n");
    expect(idx["plug-a:cached-a"]!.baseDir).toContain("plug-a/2.0.0/");
    expect(logs.join("\n")).toContain("1.0.0");
  });

  it("sets baseDir to the absolute directory containing SKILL.md", async () => {
    const result = await scanRoots({ projectRoot, userRoot, pluginCacheRoot }, { onError: () => {}, log: () => {} });
    const idx = byName(result);
    expect(idx["proj-only"]!.baseDir.endsWith("/project/.claude/skills/proj-only")).toBe(true);
    expect(idx["plug-b:cached-b"]!.baseDir.endsWith("/cache/mp1/plug-b/1.0.0/skills/cached-b")).toBe(true);
  });

  it("skips a <name>/ directory with no SKILL.md without erroring", async () => {
    const errors: string[] = [];
    const result = await scanRoots({ projectRoot, userRoot, pluginCacheRoot }, { onError: (m) => errors.push(m), log: () => {} });
    expect(result.find(s => s.name === "plug-c:orphan-no-skill")).toBeUndefined();
    expect(errors.join("\n")).not.toContain("orphan-no-skill");
  });

  it("returns layer information so the caller can order registrations", async () => {
    const result = await scanRoots({ projectRoot, userRoot, pluginCacheRoot }, { onError: () => {}, log: () => {} });
    const idx = byName(result);
    expect(idx["proj-only"]!.layer).toBe("project");
    expect(idx["user-only"]!.layer).toBe("user");
    expect(idx["plug-a:cached-a"]!.layer).toBe("plugin-cache");
  });
});

describe("scanRoots — bad frontmatter fixture", () => {
  const userRoot = join(F, "bad-frontmatter/user/.claude/skills");

  it("skips a skill with unclosed frontmatter and emits an error", async () => {
    const errors: string[] = [];
    const result = await scanRoots({ userRoot }, { onError: (m) => errors.push(m), log: () => {} });
    expect(result.find(s => s.name === "broken")).toBeUndefined();
    expect(errors.some(e => e.includes("broken"))).toBe(true);
  });

  it("skips a skill missing the description field and emits an error", async () => {
    const errors: string[] = [];
    const result = await scanRoots({ userRoot }, { onError: (m) => errors.push(m), log: () => {} });
    expect(result.find(s => s.name === "no-desc")).toBeUndefined();
    expect(errors.some(e => e.includes("no-desc"))).toBe(true);
  });

  it("never throws — bad skills are collected, scan returns", async () => {
    let threw = false;
    try {
      await scanRoots({ userRoot }, { onError: () => {}, log: () => {} });
    } catch { threw = true; }
    expect(threw).toBe(false);
  });
});

describe("scanRoots — non-existent roots", () => {
  it("returns empty results without erroring when roots don't exist", async () => {
    const errors: string[] = [];
    const result = await scanRoots(
      { projectRoot: "/does/not/exist/a", userRoot: "/does/not/exist/b", pluginCacheRoot: "/does/not/exist/c" },
      { onError: (m) => errors.push(m), log: () => {} },
    );
    expect(result).toEqual([]);
    expect(errors).toEqual([]);
  });
});
```

- [ ] **Step 3: Run tests to verify failures**

Run: `cd plugins/claude-skills && bun test test/scan.test.ts`
Expected: FAIL — module `../scan.ts` not found.

- [ ] **Step 4: Implement `scan.ts`**

```typescript
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseFrontmatter } from "./frontmatter.ts";

export type SkillLayer = "project" | "user" | "plugin-cache";

export interface ScannedSkill {
  name: string;             // e.g. "proj-only" or "plug-a:cached-a"
  description: string;
  tokens?: number;          // explicit tokens from frontmatter, if present
  baseDir: string;          // absolute realpath of the directory containing SKILL.md
  body: string;             // raw SKILL.md body (post-frontmatter)
  layer: SkillLayer;
  sourcePath: string;       // absolute path to SKILL.md
}

export interface ScanRootsConfig {
  projectRoot?: string;
  userRoot?: string;
  pluginCacheRoot?: string;
}

export interface ScanHooks {
  onError: (msg: string) => void;
  log: (msg: string) => void;
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

async function listDirs(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter(e => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith(".")).map(e => e.name);
  } catch { return []; }
}

async function readSkillDir(skillDir: string, name: string, layer: SkillLayer, hooks: ScanHooks): Promise<ScannedSkill | undefined> {
  const skillMd = join(skillDir, "SKILL.md");
  if (!(await exists(skillMd))) return undefined;
  let real: string;
  try { real = await realpath(skillDir); }
  catch (e) { hooks.onError(`[claude-skills] realpath failed for ${skillDir}: ${(e as Error).message}`); return undefined; }
  let text: string;
  try { text = await readFile(skillMd, "utf8"); }
  catch (e) { hooks.onError(`[claude-skills] read failed for ${skillMd}: ${(e as Error).message}`); return undefined; }
  const parsed = parseFrontmatter(text);
  if (!parsed.ok) { hooks.onError(`[claude-skills] frontmatter error in ${skillMd}: ${parsed.error}`); return undefined; }
  return {
    name,
    description: parsed.manifest.description,
    tokens: parsed.manifest.tokens,
    baseDir: real,
    body: parsed.body,
    layer,
    sourcePath: skillMd,
  };
}

async function scanFlatRoot(root: string, layer: "project" | "user", hooks: ScanHooks): Promise<ScannedSkill[]> {
  if (!(await exists(root))) return [];
  const out: ScannedSkill[] = [];
  for (const name of await listDirs(root)) {
    const skill = await readSkillDir(join(root, name), name, layer, hooks);
    if (skill) out.push(skill);
  }
  return out;
}

async function scanPluginCacheRoot(root: string, hooks: ScanHooks): Promise<ScannedSkill[]> {
  // Layout: <root>/<marketplace>/<plugin>/<version>/skills/<name>/SKILL.md
  if (!(await exists(root))) return [];
  const out: ScannedSkill[] = [];
  // pluginKey → { version, skill } — last write per (plug:name) wins when lex-higher version comes through.
  const byKey: Map<string, { version: string; skill: ScannedSkill }> = new Map();
  const droppedVersions: string[] = [];

  for (const marketplace of await listDirs(root)) {
    const mpDir = join(root, marketplace);
    for (const plugin of await listDirs(mpDir)) {
      const plugDir = join(mpDir, plugin);
      const versions = (await listDirs(plugDir)).sort();   // lex sort, ascending
      for (const version of versions) {
        const skillsDir = join(plugDir, version, "skills");
        if (!(await exists(skillsDir))) continue;
        for (const skillName of await listDirs(skillsDir)) {
          const dottedName = `${plugin}:${skillName}`;
          const s = await readSkillDir(join(skillsDir, skillName), dottedName, "plugin-cache", hooks);
          if (!s) continue;
          const prev = byKey.get(dottedName);
          if (prev) droppedVersions.push(`${prev.skill.sourcePath} (v${prev.version}) — superseded by v${version}`);
          byKey.set(dottedName, { version, skill: s });
        }
      }
    }
  }

  if (droppedVersions.length > 0) {
    hooks.log(`[claude-skills] plugin-cache version dedup dropped:\n  ${droppedVersions.join("\n  ")}`);
  }
  for (const { skill } of byKey.values()) out.push(skill);
  return out;
}

export async function scanRoots(cfg: ScanRootsConfig, hooks: ScanHooks): Promise<ScannedSkill[]> {
  const project = cfg.projectRoot ? await scanFlatRoot(cfg.projectRoot, "project", hooks) : [];
  const user = cfg.userRoot ? await scanFlatRoot(cfg.userRoot, "user", hooks) : [];
  const cache = cfg.pluginCacheRoot ? await scanPluginCacheRoot(cfg.pluginCacheRoot, hooks) : [];
  return [...cache, ...user, ...project];
}
```

Notes:

- Order of the returned array (cache → user → project) is intentional: when the caller registers each in array order, project entries overwrite user entries which overwrite cache entries in `skills:registry`'s programmatic layer. The spec's precedence (project > user > plugin-cache) is enforced this way.
- Returning a flat `ScannedSkill[]` (rather than `register` itself in scan) keeps scan pure. The caller (registrar) decides how to dedupe and apply.
- The lex-highest-version dedup is per-`<plugin>:<name>`, not per-`<plugin>`, because in theory two skills under one plugin can rev independently (though they usually rev together).

- [ ] **Step 5: Run tests to verify pass**

Run: `cd plugins/claude-skills && bun test test/scan.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add plugins/claude-skills/scan.ts plugins/claude-skills/test/scan.test.ts plugins/claude-skills/test/fixtures
git commit -m "claude-skills: add scan + fixture suite

Discovers SKILL.md under the three CC roots, derives names per layer
(project/user use directory basename; plugin-cache uses <plugin>:<name>),
realpaths baseDir, lex-dedupes plugin-cache by version. Bad frontmatter
and missing required fields collect errors and skip rather than throw."
```

---

## Task 7: Implement registrar.ts

**Files:**
- Create: `plugins/claude-skills/registrar.ts`
- Create: `plugins/claude-skills/test/registrar.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `plugins/claude-skills/test/registrar.test.ts`:

```typescript
import { describe, it, expect, mock } from "bun:test";
import type { SkillsRegistryService, SkillManifest } from "llm-contracts/public";
import { reconcile, type RegistrarSnapshot } from "../registrar.ts";
import type { ScannedSkill } from "../scan.ts";

function makeFakeRegistry() {
  const calls: { kind: "register" | "unregister"; name: string }[] = [];
  const unregisters = new Map<string, () => void>();
  const registry: SkillsRegistryService = {
    list: () => [] as SkillManifest[],
    load: async () => "",
    rescan: async () => ({ changed: false, count: 0 }),
    register: (manifest, _loader) => {
      calls.push({ kind: "register", name: manifest.name });
      const u = mock(() => { calls.push({ kind: "unregister", name: manifest.name }); });
      unregisters.set(manifest.name, u);
      return u;
    },
  };
  return { registry, calls };
}

function skill(name: string, body: string): ScannedSkill {
  return {
    name,
    description: `d for ${name}`,
    baseDir: `/abs/${name}`,
    body,
    layer: "user",
    sourcePath: `/abs/${name}/SKILL.md`,
  };
}

describe("reconcile", () => {
  it("registers all skills on the first pass", () => {
    const { registry, calls } = makeFakeRegistry();
    const snap: RegistrarSnapshot = new Map();
    const next = reconcile(registry, [skill("a", "A"), skill("b", "B")], snap);
    expect(calls.map(c => `${c.kind}:${c.name}`)).toEqual(["register:a", "register:b"]);
    expect(next.size).toBe(2);
  });

  it("is a no-op when the input is unchanged", () => {
    const { registry, calls } = makeFakeRegistry();
    let snap = reconcile(registry, [skill("a", "A")], new Map());
    calls.length = 0;
    snap = reconcile(registry, [skill("a", "A")], snap);
    expect(calls).toEqual([]);
    expect(snap.size).toBe(1);
  });

  it("unregisters a skill that disappeared", () => {
    const { registry, calls } = makeFakeRegistry();
    let snap = reconcile(registry, [skill("a", "A"), skill("b", "B")], new Map());
    calls.length = 0;
    snap = reconcile(registry, [skill("a", "A")], snap);
    expect(calls.map(c => `${c.kind}:${c.name}`)).toEqual(["unregister:b"]);
    expect(snap.size).toBe(1);
  });

  it("registers a newly-appearing skill", () => {
    const { registry, calls } = makeFakeRegistry();
    let snap = reconcile(registry, [skill("a", "A")], new Map());
    calls.length = 0;
    snap = reconcile(registry, [skill("a", "A"), skill("b", "B")], snap);
    expect(calls.map(c => `${c.kind}:${c.name}`)).toEqual(["register:b"]);
    expect(snap.size).toBe(2);
  });

  it("re-registers a skill whose body changed", () => {
    const { registry, calls } = makeFakeRegistry();
    let snap = reconcile(registry, [skill("a", "A1")], new Map());
    calls.length = 0;
    snap = reconcile(registry, [skill("a", "A2")], snap);
    expect(calls.map(c => `${c.kind}:${c.name}`)).toEqual(["unregister:a", "register:a"]);
    expect(snap.size).toBe(1);
  });

  it("passes baseDir, description, and tokens through to the manifest", async () => {
    const captured: SkillManifest[] = [];
    const registry: SkillsRegistryService = {
      list: () => [],
      load: async () => "",
      rescan: async () => ({ changed: false, count: 0 }),
      register: (manifest) => { captured.push(manifest); return () => {}; },
    };
    const s: ScannedSkill = { ...skill("a", "BODY"), tokens: 42 };
    reconcile(registry, [s], new Map());
    expect(captured[0]?.baseDir).toBe("/abs/a");
    expect(captured[0]?.description).toBe("d for a");
    expect(captured[0]?.tokens).toBe(42);
  });

  it("falls back to body-length heuristic when tokens is absent", () => {
    const captured: SkillManifest[] = [];
    const registry: SkillsRegistryService = {
      list: () => [], load: async () => "", rescan: async () => ({ changed: false, count: 0 }),
      register: (m) => { captured.push(m); return () => {}; },
    };
    reconcile(registry, [skill("a", "1234567890")], new Map());
    expect(captured[0]?.tokens).toBe(Math.ceil("1234567890".length / 4));
  });
});
```

- [ ] **Step 2: Run tests to verify failures**

Run: `cd plugins/claude-skills && bun test test/registrar.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `registrar.ts`**

```typescript
import type { SkillsRegistryService, SkillManifest } from "llm-contracts/public";
import type { ScannedSkill } from "./scan.ts";
import { contentHash } from "./hash.ts";

export interface SnapshotEntry {
  hash: string;
  unregister: () => void;
}

export type RegistrarSnapshot = Map<string, SnapshotEntry>;

function estimateTokens(body: string): number {
  return Math.ceil(body.length / 4);
}

function buildManifest(s: ScannedSkill): SkillManifest {
  return {
    name: s.name,
    description: s.description,
    tokens: typeof s.tokens === "number" ? s.tokens : estimateTokens(s.body),
    baseDir: s.baseDir,
  };
}

function makeLoader(s: ScannedSkill): () => Promise<string> {
  // Capture the body by value. If the file is re-read at load time, stale
  // registrations could serve a different body than they advertised; the
  // rescan loop is responsible for catching content changes and re-registering.
  return async () => s.body;
}

export function reconcile(
  registry: SkillsRegistryService,
  current: ScannedSkill[],
  previous: RegistrarSnapshot,
): RegistrarSnapshot {
  const next: RegistrarSnapshot = new Map();
  const currentByName = new Map<string, ScannedSkill>();
  for (const s of current) currentByName.set(s.name, s);

  // First pass: handle adds and changes.
  for (const [name, s] of currentByName) {
    const hash = contentHash(s.body);
    const prev = previous.get(name);
    if (prev && prev.hash === hash) {
      // Unchanged — keep the existing registration.
      next.set(name, prev);
      continue;
    }
    if (prev) {
      // Changed — unregister the old, then register the new.
      try { prev.unregister(); } catch { /* idempotent */ }
    }
    const unreg = registry.register(buildManifest(s), makeLoader(s));
    next.set(name, { hash, unregister: unreg });
  }

  // Second pass: handle removals.
  for (const [name, entry] of previous) {
    if (!currentByName.has(name)) {
      try { entry.unregister(); } catch { /* idempotent */ }
    }
  }

  return next;
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd plugins/claude-skills && bun test test/registrar.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/claude-skills/registrar.ts plugins/claude-skills/test/registrar.test.ts
git commit -m "claude-skills: add reconcile() registrar

Pure function. Diffs current scan against previous snapshot by content
hash, calls register/unregister on a SkillsRegistryService for adds,
removes, and changed bodies. Unchanged entries are passed through with
no churn on the registry."
```

---

## Task 8: Implement index.ts (plugin lifecycle)

**Files:**
- Modify: `plugins/claude-skills/index.ts`
- Create: `plugins/claude-skills/test/index.test.ts`

- [ ] **Step 1: Read llm-skills' fake-ctx test pattern first**

Read `plugins/llm-skills/test/index.test.ts` end-to-end. It's the canonical fake-ctx pattern in this repo: it builds a fake `ctx` with mocked `useService`, `consumeService`, `on`, `provideService`, `emit`. claude-skills' test should follow the same shape.

- [ ] **Step 2: Write the failing tests**

Create `plugins/claude-skills/test/index.test.ts`:

```typescript
import { describe, it, expect, mock } from "bun:test";
import { join } from "node:path";
import plugin from "../index.ts";

const FIXTURES = join(import.meta.dir, "fixtures");

interface FakeServices {
  skillsRegistry?: any;
  configStore?: any;
}

function makeCtx(opts: {
  cwd?: string;
  env?: Record<string, string | undefined>;
  services?: FakeServices;
} = {}) {
  const env = { ...process.env, HOME: "/tmp/does-not-exist", ...opts.env };
  const subscribers: Record<string, Function[]> = {};
  const services: Record<string, unknown> = {};
  if (opts.services?.skillsRegistry) services["skills:registry"] = opts.services.skillsRegistry;
  if (opts.services?.configStore) services["config:store"] = opts.services.configStore;

  const ctx: any = {
    cwd: opts.cwd,
    env,
    log: mock(() => {}),
    emit: mock(async () => {}),
    on: mock((event: string, fn: Function) => {
      (subscribers[event] ??= []).push(fn);
      return () => { subscribers[event] = (subscribers[event] ?? []).filter(f => f !== fn); };
    }),
    consumeService: mock((_id: string) => {}),
    useService: mock(<T>(id: string) => services[id] as T | undefined),
    provideService: mock(() => {}),
  };
  return { ctx, subscribers };
}

function makeFakeSkillsRegistry() {
  const registered: { name: string; baseDir?: string }[] = [];
  const unregisters: Record<string, () => void> = {};
  return {
    registered,
    unregisters,
    service: {
      list: () => [],
      load: async () => "",
      rescan: async () => ({ changed: false, count: 0 }),
      register: (manifest: any, _loader: any) => {
        registered.push({ name: manifest.name, baseDir: manifest.baseDir });
        const u = mock(() => {});
        unregisters[manifest.name] = u;
        return u;
      },
    },
  };
}

function makeFakeConfigStore(initial = { rescanIntervalMs: 30000 }) {
  let current = { ...initial };
  const watchers: Array<(next: any) => void> = [];
  const specs: any[] = [];
  return {
    push(next: any) { current = { ...current, ...next }; for (const w of watchers) w(current); },
    specs,
    service: {
      register: (spec: any) => { specs.push(spec); },
      get: () => current,
      set: async () => {},
      watch: (_plugin: string, cb: (n: any) => void) => { watchers.push(cb); return () => {}; },
      list: () => [],
      ready: async () => {},
      unset: async () => {},
      getSpec: () => undefined,
    },
  };
}

describe("claude-skills plugin", () => {
  it("declares hard deps on skills:registry and config:store", () => {
    expect(plugin.services?.consumes).toContain("skills:registry");
    expect(plugin.services?.consumes).toContain("config:store");
  });

  it("calls consumeService for both services in setup", async () => {
    const { ctx } = makeCtx({
      services: {
        skillsRegistry: makeFakeSkillsRegistry().service,
        configStore: makeFakeConfigStore().service,
      },
    });
    await plugin.setup!(ctx);
    expect((ctx.consumeService as any).mock.calls.flat()).toContain("skills:registry");
    expect((ctx.consumeService as any).mock.calls.flat()).toContain("config:store");
  });

  it("throws if skills:registry is absent", async () => {
    const { ctx } = makeCtx({ services: { configStore: makeFakeConfigStore().service } });
    await expect(plugin.setup!(ctx)).rejects.toThrow();
  });

  it("throws if config:store is absent", async () => {
    const { ctx } = makeCtx({ services: { skillsRegistry: makeFakeSkillsRegistry().service } });
    await expect(plugin.setup!(ctx)).rejects.toThrow();
  });

  it("registers a config schema with claude-skills' rescanIntervalMs field", async () => {
    const skills = makeFakeSkillsRegistry();
    const config = makeFakeConfigStore();
    const { ctx } = makeCtx({ services: { skillsRegistry: skills.service, configStore: config.service } });
    await plugin.setup!(ctx);
    expect(config.specs.length).toBe(1);
    expect(config.specs[0].plugin).toBe("claude-skills");
    expect(config.specs[0].defaults.rescanIntervalMs).toBe(30000);
    expect(config.specs[0].envVars?.rescanIntervalMs).toBe("KAIZEN_CLAUDE_SKILLS_RESCAN_MS");
  });

  it("performs an initial scan and registers skills found in the user root", async () => {
    const skills = makeFakeSkillsRegistry();
    const config = makeFakeConfigStore();
    // HOME points at the fixture's "user" dir; userRoot resolves to <HOME>/.claude/skills.
    // The plugin-cache root resolves to <HOME>/.claude/plugins/cache which doesn't exist
    // in this fixture — scanRoots returns no plugin-cache entries, which is fine.
    const { ctx } = makeCtx({
      cwd: "/tmp/does-not-exist-cwd",
      env: { HOME: join(FIXTURES, "three-roots/user") },
      services: { skillsRegistry: skills.service, configStore: config.service },
    });
    await plugin.setup!(ctx);
    // We at least expect user-only and shared from the user layer.
    const names = skills.registered.map(r => r.name).sort();
    expect(names).toContain("user-only");
    expect(names).toContain("shared");
  });

  it("subscribes to turn:start", async () => {
    const skills = makeFakeSkillsRegistry();
    const config = makeFakeConfigStore();
    const { ctx, subscribers } = makeCtx({
      services: { skillsRegistry: skills.service, configStore: config.service },
    });
    await plugin.setup!(ctx);
    expect((subscribers["turn:start"]?.length ?? 0)).toBeGreaterThan(0);
  });

  it("stop() unregisters every registered skill and is idempotent", async () => {
    const skills = makeFakeSkillsRegistry();
    const config = makeFakeConfigStore();
    const { ctx } = makeCtx({
      env: { HOME: join(FIXTURES, "three-roots/user") },
      services: { skillsRegistry: skills.service, configStore: config.service },
    });
    await plugin.setup!(ctx);
    const names = Object.keys(skills.unregisters);
    expect(names.length).toBeGreaterThan(0);

    await plugin.stop!(ctx);
    for (const n of names) {
      expect((skills.unregisters[n] as any).mock.calls.length).toBe(1);
    }

    // Second stop is a no-op.
    await plugin.stop!(ctx);
    for (const n of names) {
      expect((skills.unregisters[n] as any).mock.calls.length).toBe(1);
    }
  });
});
```

Note: the "initial scan" test assumes claude-skills resolves `userRoot` to `${HOME}/.claude/skills`. If your `index.ts` resolves it differently (e.g., honors an explicit `KAIZEN_CLAUDE_SKILLS_PATH` env var first), update the test or set that env in the fake ctx.

- [ ] **Step 3: Run tests to verify failures**

Run: `cd plugins/claude-skills && bun test test/index.test.ts`
Expected: FAIL — placeholder `setup` runs but registers nothing, subscribes to nothing, throws nowhere.

- [ ] **Step 4: Implement `index.ts`**

Replace the entire contents of `plugins/claude-skills/index.ts` with:

```typescript
import type { KaizenPlugin } from "kaizen/types";
import type { SkillsRegistryService, ConfigStoreService } from "llm-contracts/public";
import { homedir } from "node:os";
import { join } from "node:path";
import { scanRoots } from "./scan.ts";
import { reconcile, type RegistrarSnapshot } from "./registrar.ts";

interface ClaudeSkillsConfig {
  rescanIntervalMs: number;
}

const DEFAULTS: ClaudeSkillsConfig = { rescanIntervalMs: 30000 };

function readEnv(ctx: any, key: string): string | undefined {
  const fromCtx = ctx.env && typeof ctx.env === "object" ? (ctx.env as Record<string, string | undefined>)[key] : undefined;
  if (typeof fromCtx === "string" && fromCtx.length > 0) return fromCtx;
  const fromProc = process.env[key];
  return fromProc && fromProc.length > 0 ? fromProc : undefined;
}

function resolveRoots(ctx: any): { projectRoot: string; userRoot: string; pluginCacheRoot: string } {
  const home = readEnv(ctx, "HOME") ?? homedir();
  const cwd = typeof ctx.cwd === "string" && ctx.cwd.length > 0 ? ctx.cwd : process.cwd();
  return {
    projectRoot: join(cwd, ".claude", "skills"),
    userRoot: join(home, ".claude", "skills"),
    pluginCacheRoot: join(home, ".claude", "plugins", "cache"),
  };
}

let snapshot: RegistrarSnapshot = new Map();
let unwatchConfig: (() => void) | undefined;
let currentIntervalMs = DEFAULTS.rescanIntervalMs;

const plugin: KaizenPlugin = {
  name: "claude-skills",
  apiVersion: "3.0.0",
  permissions: { tier: "unscoped" },
  services: { consumes: ["skills:registry", "config:store"] },

  async setup(ctx) {
    ctx.consumeService("skills:registry");
    ctx.consumeService("config:store");

    const skills = ctx.useService<SkillsRegistryService>("skills:registry");
    if (!skills) throw new Error("claude-skills: skills:registry service not available");

    const cfgSvc = ctx.useService<ConfigStoreService>("config:store");
    if (!cfgSvc) throw new Error("claude-skills: config:store service not available");

    cfgSvc.register<ClaudeSkillsConfig>({
      plugin: "claude-skills",
      defaults: { ...DEFAULTS },
      schema: {
        rescanIntervalMs: { type: "number", integer: true, min: 1 },
      },
      envVars: { rescanIntervalMs: "KAIZEN_CLAUDE_SKILLS_RESCAN_MS" },
    });
    const initialCfg = cfgSvc.get<ClaudeSkillsConfig>("claude-skills");
    currentIntervalMs = initialCfg.rescanIntervalMs;
    unwatchConfig = cfgSvc.watch<ClaudeSkillsConfig>("claude-skills", (next) => {
      currentIntervalMs = next.rescanIntervalMs;
    });

    const roots = resolveRoots(ctx);
    const hooks = {
      onError: (m: string) => { void ctx.emit("harness:error", { message: m }); },
      log: (m: string) => { ctx.log(m); },
    };

    const initial = await scanRoots(roots, hooks);
    snapshot = reconcile(skills, initial, snapshot);

    let lastScanAt = Date.now();
    ctx.on("turn:start", async () => {
      const now = Date.now();
      if (now - lastScanAt < currentIntervalMs) return;
      lastScanAt = now;
      try {
        const current = await scanRoots(roots, hooks);
        snapshot = reconcile(skills, current, snapshot);
      } catch (e) {
        void ctx.emit("harness:error", { message: `claude-skills: rescan failed: ${(e as Error).message}` });
      }
    });
  },

  async stop() {
    for (const entry of snapshot.values()) {
      try { entry.unregister(); } catch { /* idempotent */ }
    }
    snapshot = new Map();
    try { unwatchConfig?.(); } catch { /* idempotent */ }
    unwatchConfig = undefined;
  },
};

export default plugin;
```

- [ ] **Step 5: Run all claude-skills tests**

Run: `cd plugins/claude-skills && bun test`
Expected: PASS — every test in every file.

- [ ] **Step 6: Commit**

```bash
git add plugins/claude-skills/index.ts plugins/claude-skills/test/index.test.ts
git commit -m "claude-skills: implement plugin lifecycle

Resolves the three CC roots, registers a config schema with config:store,
hard-consumes skills:registry, runs an initial scan + register on setup,
subscribes to turn:start for throttled rescans, drains registrations on
stop(). currentIntervalMs is held in module scope and updated by the
config:store watch callback so /config:set takes effect on the next turn."
```

---

## Task 9: Wire into harnesses/local.json + local deploy + validate

**Files:**
- Modify: `harnesses/local.json`

- [ ] **Step 1: Add claude-skills to the local harness**

Edit `harnesses/local.json`. Insert `"official/claude-skills@0.1.0"` immediately after the `llm-skills` entry. The result:

```jsonc
{
  "plugins": [
    "...",
    "official/llm-skills@0.1.3",
    "official/claude-skills@0.1.0",
    "..."
  ]
}
```

(Use whatever version `llm-skills` ended up at in Task 2.)

- [ ] **Step 2: Run `kaizen plugin validate`**

Run: `kaizen plugin validate plugins/claude-skills`
Expected: PASS — no manifest errors, no permission errors.

- [ ] **Step 3: Local-deploy claude-skills**

```bash
PLUGIN=claude-skills
VERSION=$(jq -r .version plugins/$PLUGIN/package.json)
INSTALL_DIR=~/.kaizen/marketplaces/official/plugins/${PLUGIN}@${VERSION}
(cd plugins/$PLUGIN && bun build --target=bun --outfile=dist/index.js index.ts)
mkdir -p "$INSTALL_DIR/dist"
cp plugins/$PLUGIN/dist/index.js "$INSTALL_DIR/dist/index.js"
rsync -a --exclude='node_modules' --exclude='dist' plugins/$PLUGIN/ "$INSTALL_DIR/"
```

- [ ] **Step 4: Smoke-test the local harness**

Run: `kaizen --harness ./harnesses/local.json`
Expected: harness boots cleanly. In the TUI, run `/skills` (or whatever `llm-skills` exposes — check its README). You should see at least the skills from your live `~/.claude/skills/` directory listed. Quit cleanly.

If the harness errors at boot complaining about `claude-skills`, capture the message — likely the install dir didn't sync or the marketplace catalog needs an update. See `plugins/llm-skills/CLAUDE.md`'s "Local deploy" section for the marketplace-repo sync note.

- [ ] **Step 5: Run the whole test suite**

Run: `bun test`
Expected: every plugin's tests pass.

- [ ] **Step 6: Commit**

```bash
git add harnesses/local.json
git commit -m "harnesses/local: wire claude-skills

Adds claude-skills to the local harness immediately after llm-skills.
Reads ~/.claude/skills/, <cwd>/.claude/skills/, and the CC plugin cache,
registers entries programmatically with skills:registry. The CC-binary-
backed claude-wrapper harness is unchanged (CC handles its own skills
natively there)."
```

---

## Acceptance

- [ ] `bun test` is green across all plugins.
- [ ] `kaizen plugin validate plugins/claude-skills` passes.
- [ ] `kaizen --harness ./harnesses/local.json` boots and lists at least one CC skill from `~/.claude/skills/` in the available-skills section.
- [ ] Loading a CC skill via `load_skill` in the local harness produces a body that starts with `Base directory for this skill: ` followed by an absolute path.
- [ ] Removing `claude-skills` from the harness manifest, restarting, and re-running causes the harness to boot cleanly with no CC skills visible — verifying the shim is the source.
