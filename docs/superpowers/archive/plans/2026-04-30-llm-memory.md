# llm-memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the `llm-memory` Kaizen plugin (Spec 9) — a passive subscriber + active service provider that injects merged `MEMORY.md` blocks into every LLM call, persists Claude-Code-compatible markdown memories under `~/.kaizen/memory/` and `<project>/.kaizen/memory/`, and exposes `memory:store` plus the `memory_recall` / `memory_save` tools.

**Architecture:** Microservice plugin with layered modules (`paths → frontmatter → store → catalog → injection → tools → extract → service → index`). Each layer is unit-testable in isolation against a real tmpdir. No external runtime deps beyond `llm-events` (vocabulary + shared types) and (at registration time) `tools:registry`. Atomic `temp-write-then-rename` with crash-safe `.tmp.*` sweeper. Auto-extraction is opt-in and off by default.

**Tech Stack:** TypeScript, Bun runtime, `node:fs/promises`, `node:path`, `node:crypto` (random suffix), `node:os` (homedir). Tests use `bun:test` with a real tmpdir. No external runtime deps.

---

## Prerequisites & Tier-for-Parallelism Map

This plan implements one plugin (`llm-memory`). It depends on `llm-events` (already shipped, see `plugins/llm-events/`) for the `Vocab` type, the `LLMRequest` type, and the `llm-events:vocabulary` service. It optionally depends on `tools:registry` (Spec 3, `llm-tools-registry`) — registration is best-effort: if the service is not present at setup time, tool registration is skipped with a log message.

Tiers below indicate what may run in parallel (no shared writes, no read-after-write):

- **Tier 0** (sequential, blocks all others): Task 1 (scaffold).
- **Tier 1A** (parallel, leaf modules): Task 2 (`paths.ts`), Task 3 (`frontmatter.ts`), Task 4 (`config.ts`).
- **Tier 1B** (parallel after Tier 1A): Task 5 (`store.ts` — depends on `paths` + `frontmatter`), Task 6 (`catalog.ts` — depends on `paths` + `frontmatter`).
- **Tier 1C** (sequential after Tier 1B): Task 7 (`injection.ts` — uses `store` + `catalog`), Task 8 (`tools.ts` — uses `store`), Task 9 (`extract.ts` — uses `store` + driver service).
- **Tier 1D** (sequential, integrates): Task 10 (`service.ts` — assembles `MemoryStoreService`), Task 11 (`index.ts` — wire setup), Task 12 (`public.d.ts` re-exports), Task 13 (fixtures + integration), Task 14 (marketplace catalog).

## File Structure

```
plugins/llm-memory/
  index.ts            # KaizenPlugin: load config, build store, subscribe llm:before-call, register tools, sweep stale tmp files
  paths.ts            # resolveDirs(config, deps): { projectDir, globalDir }; ensureDir(p); listMemoryFiles(dir)
  frontmatter.ts      # parseEntry(text): { meta, body } | null; renderEntry(entry): string; validateName(name)
  store.ts            # makeStore(deps): MemoryStoreService — get/list/search/put/remove/readIndex; atomic write
  catalog.ts          # renderCatalog(entries): string; mergeIntoIndex(prevIndex, catalog): string; CATALOG_START/END markers
  injection.ts        # buildMemoryBlock(projectIdx, globalIdx, projectEntries, globalEntries, cap): string | null
  tools.ts            # registerTools(registry, store, ctx): void — memory_recall + memory_save
  extract.ts          # maybeExtract(turnEndPayload, deps): Promise<void> — heuristic + side driver call
  service.ts          # makeMemoryStore(config, deps): MemoryStoreService (the implementation behind memory:store)
  config.ts           # MemoryConfig type, loadConfig(deps)
  public.d.ts         # re-export MemoryEntry, MemoryType, MemoryScope, MemoryStoreService
  package.json
  tsconfig.json
  README.md
  test/
    paths.test.ts
    frontmatter.test.ts
    config.test.ts
    store.test.ts
    catalog.test.ts
    injection.test.ts
    tools.test.ts
    extract.test.ts
    service.test.ts
    index.test.ts
    fixtures/
      hand-authored-memory.md             # entry without created/updated, for portability test
      claude-code-style-memory-dir/       # mini directory mirror of `~/.claude/projects/<slug>/memory/`
        MEMORY.md
        bun_git_dep_semver.md
        vault_namespace.md
```

Boundaries:
- `paths.ts`: pure functions over a `home`/`cwd`/fs facade.
- `frontmatter.ts`: pure parse/render. No I/O.
- `store.ts`: only place that touches disk; all writes go through `atomicWrite` here.
- `catalog.ts`: pure string manipulation around the `<!-- llm-memory:catalog:start -->` markers.
- `injection.ts`: pure rendering of the system-prompt block, byte-cap aware.
- `tools.ts`: thin adapters over `store` that match the `memory_recall` / `memory_save` schemas.
- `extract.ts`: opt-in heuristic; no-ops when disabled or when `driver:run-conversation` not available.
- `service.ts`: composes the above into the `MemoryStoreService` exported via `memory:store`.
- `index.ts`: only place that wires events, services, and the optional tools registration.

`.kaizen/marketplace.json` is also modified (Task 14).

---

## Task 1: Scaffold `llm-memory` plugin skeleton (Tier 0)

**Files:**
- Create: `plugins/llm-memory/package.json`
- Create: `plugins/llm-memory/tsconfig.json`
- Create: `plugins/llm-memory/README.md`
- Create: `plugins/llm-memory/index.ts` (placeholder)
- Create: `plugins/llm-memory/public.d.ts` (placeholder)
- Create: `plugins/llm-memory/test/index.test.ts` (smoke)

The placeholder index/public is required so `bun install` and TypeScript can resolve the workspace package; module bodies are filled in by Tasks 10/11/12.

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "llm-memory",
  "version": "0.1.0",
  "description": "File-backed persistent memory plugin (memory:store + memory_recall/memory_save tools + llm:before-call injection)",
  "type": "module",
  "exports": { ".": "./index.ts" },
  "keywords": ["kaizen-plugin"],
  "dependencies": {
    "llm-events": "workspace:*"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "@types/json-schema": "^7.0.15",
    "typescript": "^5.4.0"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true
  }
}
```

- [ ] **Step 3: Write placeholder `index.ts`**

```ts
import type { KaizenPlugin } from "kaizen/types";

const plugin: KaizenPlugin = {
  name: "llm-memory",
  apiVersion: "3.0.0",
  permissions: { tier: "trusted" },
  services: {
    provides: ["memory:store"],
    consumes: ["llm-events:vocabulary", "tools:registry", "driver:run-conversation"],
  },
  async setup(ctx) {
    // Filled in by Task 11.
    ctx.defineService("memory:store", { description: "File-backed persistent memory store." });
  },
};

export default plugin;
```

- [ ] **Step 4: Write placeholder `public.d.ts`**

```ts
export type MemoryType = "user" | "feedback" | "project" | "reference";
export type MemoryScope = "project" | "global";

export interface MemoryEntry {
  name: string;
  description: string;
  type: MemoryType;
  scope: MemoryScope;
  body: string;
  created?: string;
  updated?: string;
}

export interface MemoryStoreService {
  get(name: string, opts?: { scope?: MemoryScope }): Promise<MemoryEntry | null>;
  list(filter?: { type?: MemoryType; scope?: MemoryScope }): Promise<MemoryEntry[]>;
  search(query: string, opts?: { scope?: MemoryScope; limit?: number }): Promise<MemoryEntry[]>;
  put(entry: MemoryEntry): Promise<void>;
  remove(name: string, scope: MemoryScope): Promise<void>;
  readIndex(scope: MemoryScope): Promise<string>;
}
```

- [ ] **Step 5: Write `README.md`** (one paragraph):

```markdown
# llm-memory

File-backed persistent memory for the openai-compatible harness. Reads/writes
Claude-Code-compatible markdown memories under `<project>/.kaizen/memory/` and
`~/.kaizen/memory/`, injects the merged `MEMORY.md` blocks into every LLM
request via `llm:before-call`, and exposes a `memory:store` service plus the
`memory_recall` and `memory_save` tools.

Add `.kaizen/memory/` to your project's `.gitignore` if you do not want
project memory committed. Auto-extraction is OFF by default — see the
`autoExtract` setting and the privacy notes below before enabling.
```

- [ ] **Step 6: Write smoke test**

`plugins/llm-memory/test/index.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import plugin from "../index.ts";

describe("llm-memory metadata", () => {
  it("name + apiVersion", () => {
    expect(plugin.name).toBe("llm-memory");
    expect(plugin.apiVersion).toBe("3.0.0");
  });
  it("declares trusted tier", () => {
    expect(plugin.permissions?.tier).toBe("trusted");
  });
  it("provides memory:store", () => {
    expect(plugin.services?.provides).toContain("memory:store");
  });
});
```

- [ ] **Step 7: Refresh workspace install**

Run: `bun install`
Expected: workspace resolves `llm-memory`; no errors.

- [ ] **Step 8: Run smoke test**

Run: `bun test plugins/llm-memory/`
Expected: 3 tests PASS.

- [ ] **Step 9: Commit**

```bash
git add plugins/llm-memory/
git commit -m "feat(llm-memory): scaffold plugin package (skeleton only)"
```

---

## Task 2: `paths.ts` — resolve dirs, ensure dir, list memory files (Tier 1A)

**Files:**
- Create: `plugins/llm-memory/paths.ts`
- Create: `plugins/llm-memory/test/paths.test.ts`

`paths.ts` exposes a small filesystem facade so higher layers can be tested with a real tmpdir. Pure logic for path resolution, side-effecting helpers behind a `FsDeps` interface.

- [ ] **Step 1: Write the failing test**

```ts
// plugins/llm-memory/test/paths.test.ts
import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDirs, ensureDir, listMemoryFiles, sweepStaleTempFiles } from "../paths.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "llm-memory-paths-"));
}

describe("resolveDirs", () => {
  it("uses defaults: <home>/.kaizen/memory and <cwd>/.kaizen/memory", () => {
    const out = resolveDirs({ home: "/home/u", cwd: "/work/p", config: {} });
    expect(out.globalDir).toBe("/home/u/.kaizen/memory");
    expect(out.projectDir).toBe("/work/p/.kaizen/memory");
  });
  it("honors absolute overrides verbatim", () => {
    const out = resolveDirs({ home: "/h", cwd: "/c", config: { globalDir: "/etc/g", projectDir: "/etc/p" } });
    expect(out.globalDir).toBe("/etc/g");
    expect(out.projectDir).toBe("/etc/p");
  });
  it("expands leading ~ in overrides", () => {
    const out = resolveDirs({ home: "/h", cwd: "/c", config: { globalDir: "~/x", projectDir: "~/y" } });
    expect(out.globalDir).toBe("/h/x");
    expect(out.projectDir).toBe("/h/y");
  });
  it("projectDir=null disables project layer", () => {
    const out = resolveDirs({ home: "/h", cwd: "/c", config: { projectDir: null } });
    expect(out.projectDir).toBeNull();
  });
});

describe("ensureDir", () => {
  it("creates a missing directory recursively", async () => {
    const root = tmp();
    const target = join(root, "a", "b", "c");
    await ensureDir(target);
    expect(existsSync(target)).toBe(true);
  });
  it("is a no-op for an existing directory", async () => {
    const root = tmp();
    await ensureDir(root);
    await ensureDir(root); // must not throw
    expect(existsSync(root)).toBe(true);
  });
});

describe("listMemoryFiles", () => {
  it("returns *.md files (excluding MEMORY.md and dotfiles)", async () => {
    const root = tmp();
    writeFileSync(join(root, "a.md"), "x");
    writeFileSync(join(root, "b.md"), "x");
    writeFileSync(join(root, "MEMORY.md"), "x");
    writeFileSync(join(root, ".hidden.md"), "x");
    writeFileSync(join(root, "notes.txt"), "x");
    const files = await listMemoryFiles(root);
    expect(files.sort()).toEqual(["a.md", "b.md"]);
  });
  it("returns [] for a missing directory", async () => {
    expect(await listMemoryFiles(join(tmp(), "nope"))).toEqual([]);
  });
});

describe("sweepStaleTempFiles", () => {
  it("removes .tmp.* older than threshold; preserves fresh ones", async () => {
    const root = tmp();
    const stalePath = join(root, "x.md.tmp.1.abcd");
    const freshPath = join(root, "x.md.tmp.2.efgh");
    writeFileSync(stalePath, "stale");
    writeFileSync(freshPath, "fresh");
    // Backdate stalePath
    const past = Date.now() - 5 * 60 * 1000;
    const fs = await import("node:fs/promises");
    await fs.utimes(stalePath, past / 1000, past / 1000);
    const removed = await sweepStaleTempFiles(root, 60_000);
    expect(removed).toContain(stalePath);
    expect(existsSync(stalePath)).toBe(false);
    expect(existsSync(freshPath)).toBe(true);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `bun test plugins/llm-memory/test/paths.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `paths.ts`**

```ts
import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

export interface ResolveDirsInput {
  home: string;
  cwd: string;
  config: { globalDir?: string | null; projectDir?: string | null };
}

export interface ResolvedDirs {
  globalDir: string;
  projectDir: string | null;
}

function expandHome(home: string, p: string): string {
  if (p.startsWith("~/")) return join(home, p.slice(2));
  if (p === "~") return home;
  return p;
}

export function resolveDirs(input: ResolveDirsInput): ResolvedDirs {
  const { home, cwd, config } = input;
  const global =
    config.globalDir === undefined || config.globalDir === null
      ? join(home, ".kaizen", "memory")
      : expandHome(home, config.globalDir);
  let project: string | null;
  if (config.projectDir === null) {
    project = null;
  } else if (config.projectDir === undefined) {
    project = join(cwd, ".kaizen", "memory");
  } else {
    project = expandHome(home, config.projectDir);
  }
  return { globalDir: global, projectDir: project };
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function listMemoryFiles(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err: any) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
  return entries.filter(
    (e) => e.endsWith(".md") && e !== "MEMORY.md" && !e.startsWith("."),
  );
}

export async function sweepStaleTempFiles(dir: string, thresholdMs: number): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const now = Date.now();
  const removed: string[] = [];
  for (const e of entries) {
    if (!e.includes(".tmp.")) continue;
    const full = join(dir, e);
    try {
      const st = await stat(full);
      if (now - st.mtimeMs >= thresholdMs) {
        await unlink(full);
        removed.push(full);
      }
    } catch {
      // ignore
    }
  }
  return removed;
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `bun test plugins/llm-memory/test/paths.test.ts`
Expected: 8 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-memory/paths.ts plugins/llm-memory/test/paths.test.ts
git commit -m "feat(llm-memory): paths module (resolve/ensure/list/sweep)"
```

---

## Task 3: `frontmatter.ts` — parse + render entry markdown (Tier 1A)

**Files:**
- Create: `plugins/llm-memory/frontmatter.ts`
- Create: `plugins/llm-memory/test/frontmatter.test.ts`

Parses and renders memory files. Frontmatter format is YAML-subset (we only need the four keys plus `created`/`updated`); we hand-roll a tiny parser limited to `key: value` lines so we have no YAML dependency. Also exports `validateName` (`[a-z0-9_-]+`, max 64).

- [ ] **Step 1: Write the failing test**

```ts
// plugins/llm-memory/test/frontmatter.test.ts
import { describe, it, expect } from "bun:test";
import { parseEntry, renderEntry, validateName } from "../frontmatter.ts";
import type { MemoryEntry } from "../public.d.ts";

const sample = `---
name: bun_git_dep_semver
description: Bun #semver over git URLs unsupported
type: reference
created: 2026-04-15T10:23:00Z
updated: 2026-04-30T08:11:00Z
---

# Body

Long-form markdown content.
`;

describe("validateName", () => {
  it("accepts lowercase, digits, underscore, hyphen", () => {
    expect(validateName("a")).toBe(true);
    expect(validateName("a-b_c-1")).toBe(true);
  });
  it("rejects empty, uppercase, spaces, punctuation, > 64", () => {
    expect(validateName("")).toBe(false);
    expect(validateName("Aa")).toBe(false);
    expect(validateName("a b")).toBe(false);
    expect(validateName("a.b")).toBe(false);
    expect(validateName("a".repeat(65))).toBe(false);
    expect(validateName("a".repeat(64))).toBe(true);
  });
  it("accepts a name with the `!` overwrite suffix", () => {
    // validateName itself rejects '!'; callers strip the suffix before validating.
    expect(validateName("foo!")).toBe(false);
  });
});

describe("parseEntry", () => {
  it("parses frontmatter + body", () => {
    const out = parseEntry(sample, "project");
    expect(out).not.toBeNull();
    expect(out!.name).toBe("bun_git_dep_semver");
    expect(out!.description).toBe("Bun #semver over git URLs unsupported");
    expect(out!.type).toBe("reference");
    expect(out!.scope).toBe("project");
    expect(out!.created).toBe("2026-04-15T10:23:00Z");
    expect(out!.updated).toBe("2026-04-30T08:11:00Z");
    expect(out!.body).toBe("# Body\n\nLong-form markdown content.\n");
  });
  it("returns null when frontmatter delimiters missing", () => {
    expect(parseEntry("no frontmatter here", "project")).toBeNull();
  });
  it("returns null when type is invalid", () => {
    const bad = sample.replace("type: reference", "type: nonsense");
    expect(parseEntry(bad, "project")).toBeNull();
  });
  it("tolerates absence of created/updated", () => {
    const text = `---\nname: x\ndescription: d\ntype: user\n---\nbody`;
    const out = parseEntry(text, "global");
    expect(out!.name).toBe("x");
    expect(out!.created).toBeUndefined();
    expect(out!.updated).toBeUndefined();
  });
  it("ignores unknown keys without throwing", () => {
    const text = `---\nname: x\ndescription: d\ntype: user\nfoo: bar\n---\nbody`;
    const out = parseEntry(text, "global");
    expect(out!.name).toBe("x");
  });
  it("rejects descriptions longer than 200 chars", () => {
    const text = `---\nname: x\ndescription: ${"a".repeat(201)}\ntype: user\n---\nbody`;
    expect(parseEntry(text, "global")).toBeNull();
  });
});

describe("renderEntry", () => {
  it("round-trips through parse", () => {
    const entry: MemoryEntry = {
      name: "vault_namespace",
      description: "Vault namespace is admin",
      type: "reference",
      scope: "global",
      body: "# Notes\n\nUse `admin`.\n",
      created: "2026-04-15T00:00:00Z",
      updated: "2026-04-30T00:00:00Z",
    };
    const text = renderEntry(entry);
    const parsed = parseEntry(text, "global")!;
    expect(parsed.name).toBe(entry.name);
    expect(parsed.description).toBe(entry.description);
    expect(parsed.type).toBe(entry.type);
    expect(parsed.created).toBe(entry.created);
    expect(parsed.updated).toBe(entry.updated);
    expect(parsed.body).toBe(entry.body);
  });
  it("omits created/updated keys when not provided", () => {
    const text = renderEntry({ name: "x", description: "d", type: "user", scope: "global", body: "b" });
    expect(text).not.toContain("created:");
    expect(text).not.toContain("updated:");
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `bun test plugins/llm-memory/test/frontmatter.test.ts`

- [ ] **Step 3: Implement `frontmatter.ts`**

```ts
import type { MemoryEntry, MemoryType, MemoryScope } from "./public.d.ts";

const NAME_RE = /^[a-z0-9_-]{1,64}$/;
const VALID_TYPES = new Set<MemoryType>(["user", "feedback", "project", "reference"]);
const MAX_DESC = 200;

export function validateName(name: string): boolean {
  return NAME_RE.test(name);
}

interface Meta {
  name?: string;
  description?: string;
  type?: string;
  created?: string;
  updated?: string;
}

function parseFrontmatter(block: string): Meta | null {
  const meta: Meta = {};
  for (const raw of block.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line === "") continue;
    const idx = line.indexOf(":");
    if (idx === -1) return null;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    // Strip surrounding single or double quotes if present.
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key === "name" || key === "description" || key === "type" || key === "created" || key === "updated") {
      (meta as any)[key] = value;
    }
    // Unknown keys are ignored (forward-compat with hand-edited files).
  }
  return meta;
}

export function parseEntry(text: string, scope: MemoryScope): MemoryEntry | null {
  // Must start with `---\n` (allowing optional BOM).
  const stripped = text.replace(/^﻿/, "");
  if (!stripped.startsWith("---")) return null;
  // Find closing `\n---\n` or `\n---\r\n` after the opening line.
  const firstNl = stripped.indexOf("\n");
  if (firstNl === -1) return null;
  const close = stripped.indexOf("\n---", firstNl + 1);
  if (close === -1) return null;
  const block = stripped.slice(firstNl + 1, close);
  // Body starts after `\n---` + the line break that follows.
  let bodyStart = close + 4; // after `\n---`
  if (stripped[bodyStart] === "\r") bodyStart++;
  if (stripped[bodyStart] === "\n") bodyStart++;
  const body = stripped.slice(bodyStart);

  const meta = parseFrontmatter(block);
  if (!meta) return null;
  if (!meta.name || !meta.description || !meta.type) return null;
  if (!validateName(meta.name)) return null;
  if (meta.description.length > MAX_DESC) return null;
  if (!VALID_TYPES.has(meta.type as MemoryType)) return null;

  return {
    name: meta.name,
    description: meta.description,
    type: meta.type as MemoryType,
    scope,
    body,
    created: meta.created,
    updated: meta.updated,
  };
}

export function renderEntry(entry: MemoryEntry): string {
  const lines: string[] = ["---"];
  lines.push(`name: ${entry.name}`);
  lines.push(`description: ${entry.description}`);
  lines.push(`type: ${entry.type}`);
  if (entry.created) lines.push(`created: ${entry.created}`);
  if (entry.updated) lines.push(`updated: ${entry.updated}`);
  lines.push("---");
  lines.push("");
  return lines.join("\n") + entry.body;
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `bun test plugins/llm-memory/test/frontmatter.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-memory/frontmatter.ts plugins/llm-memory/test/frontmatter.test.ts
git commit -m "feat(llm-memory): frontmatter parse/render + name validator"
```

---

## Task 4: `config.ts` — load and validate plugin settings (Tier 1A)

**Files:**
- Create: `plugins/llm-memory/config.ts`
- Create: `plugins/llm-memory/test/config.test.ts`

Loads plugin settings from `~/.kaizen/plugins/llm-memory/config.json` (or `KAIZEN_LLM_MEMORY_CONFIG`). Pure function over a `ConfigDeps` facade so tests can stub.

- [ ] **Step 1: Write the failing tests**

```ts
// plugins/llm-memory/test/config.test.ts
import { describe, it, expect, mock } from "bun:test";
import { loadConfig, DEFAULT_CONFIG, type ConfigDeps } from "../config.ts";

function makeDeps(overrides: Partial<ConfigDeps> = {}): ConfigDeps {
  return {
    home: "/home/u",
    env: {},
    readFile: async () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); },
    log: mock(() => {}),
    ...overrides,
  };
}

describe("loadConfig", () => {
  it("returns defaults when file is absent", async () => {
    const cfg = await loadConfig(makeDeps());
    expect(cfg).toEqual(DEFAULT_CONFIG);
  });
  it("honors KAIZEN_LLM_MEMORY_CONFIG env override", async () => {
    let path = "";
    const cfg = await loadConfig(makeDeps({
      env: { KAIZEN_LLM_MEMORY_CONFIG: "/etc/m.json" },
      readFile: async (p: string) => { path = p; return JSON.stringify({ injectionByteCap: 4096 }); },
    }));
    expect(path).toBe("/etc/m.json");
    expect(cfg.injectionByteCap).toBe(4096);
  });
  it("merges file values over defaults", async () => {
    const cfg = await loadConfig(makeDeps({
      readFile: async () => JSON.stringify({ autoExtract: true, denyTypes: ["feedback"] }),
    }));
    expect(cfg.autoExtract).toBe(true);
    expect(cfg.denyTypes).toEqual(["feedback"]);
    expect(cfg.injectionByteCap).toBe(2048);
  });
  it("throws on malformed JSON", async () => {
    await expect(loadConfig(makeDeps({ readFile: async () => "{not-json" })))
      .rejects.toThrow(/llm-memory config.*malformed/i);
  });
  it("rejects non-positive injectionByteCap", async () => {
    await expect(loadConfig(makeDeps({ readFile: async () => JSON.stringify({ injectionByteCap: 0 }) })))
      .rejects.toThrow();
  });
  it("rejects unknown denyTypes entries", async () => {
    await expect(loadConfig(makeDeps({ readFile: async () => JSON.stringify({ denyTypes: ["nonsense"] }) })))
      .rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `bun test plugins/llm-memory/test/config.test.ts`

- [ ] **Step 3: Implement `config.ts`**

```ts
import { readFile as fsReadFile } from "node:fs/promises";
import type { MemoryType } from "./public.d.ts";

export interface MemoryConfig {
  globalDir: string | null;          // null = unsupported (always set); typed for parity with projectDir.
  projectDir: string | null;         // null disables project layer
  injectionByteCap: number;
  autoExtract: boolean;
  extractTriggers: string[];
  denyTypes: MemoryType[];
  staleTempMs: number;               // sweeper threshold
}

const DEFAULT_TRIGGERS = [
  "from now on",
  "remember that",
  "always",
  "never",
  "i prefer",
  "my ",
];

export const DEFAULT_CONFIG: MemoryConfig = Object.freeze({
  globalDir: null,
  projectDir: null,
  injectionByteCap: 2048,
  autoExtract: false,
  extractTriggers: [...DEFAULT_TRIGGERS],
  denyTypes: [],
  staleTempMs: 60_000,
}) as MemoryConfig;

const VALID_TYPES = new Set<MemoryType>(["user", "feedback", "project", "reference"]);

export interface ConfigDeps {
  home: string;
  env: Record<string, string | undefined>;
  readFile: (path: string) => Promise<string>;
  log: (msg: string) => void;
}

export function defaultConfigPath(home: string): string {
  return `${home}/.kaizen/plugins/llm-memory/config.json`;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validate(cfg: MemoryConfig): void {
  if (cfg.injectionByteCap <= 0) throw new Error("llm-memory config: injectionByteCap must be > 0");
  if (cfg.staleTempMs < 0) throw new Error("llm-memory config: staleTempMs must be >= 0");
  for (const t of cfg.denyTypes) {
    if (!VALID_TYPES.has(t)) throw new Error(`llm-memory config: denyTypes contains unknown type "${t}"`);
  }
}

export async function loadConfig(deps: ConfigDeps): Promise<MemoryConfig> {
  const path = deps.env.KAIZEN_LLM_MEMORY_CONFIG ?? defaultConfigPath(deps.home);
  let raw: string | null = null;
  try {
    raw = await deps.readFile(path);
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      deps.log(`llm-memory: no config at ${path}; using defaults`);
      return { ...DEFAULT_CONFIG, extractTriggers: [...DEFAULT_CONFIG.extractTriggers], denyTypes: [] };
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`llm-memory config at ${path} malformed: ${(err as Error).message}`);
  }
  if (!isPlainObject(parsed)) throw new Error(`llm-memory config at ${path} must be a JSON object`);
  const merged: MemoryConfig = {
    ...DEFAULT_CONFIG,
    ...parsed,
    extractTriggers: Array.isArray((parsed as any).extractTriggers)
      ? (parsed as any).extractTriggers.map((s: unknown) => String(s).toLowerCase())
      : [...DEFAULT_CONFIG.extractTriggers],
    denyTypes: Array.isArray((parsed as any).denyTypes) ? (parsed as any).denyTypes : [],
  } as MemoryConfig;
  validate(merged);
  return merged;
}

export function realDeps(log: (msg: string) => void): ConfigDeps {
  return {
    home: process.env.HOME ?? "/",
    env: process.env as Record<string, string | undefined>,
    readFile: (p) => fsReadFile(p, "utf8"),
    log,
  };
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `bun test plugins/llm-memory/test/config.test.ts`

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-memory/config.ts plugins/llm-memory/test/config.test.ts
git commit -m "feat(llm-memory): config loader with env override + validation"
```

---

## Task 5: `store.ts` — atomic CRUD over memory directories (Tier 1B)

**Files:**
- Create: `plugins/llm-memory/store.ts`
- Create: `plugins/llm-memory/test/store.test.ts`

The `store.ts` module is the only place that writes to disk. It exposes `makeStore(deps)` returning a service with `get/list/search/put/remove/readIndex`. Writes use `temp-write-then-rename` per spec section "Concurrency and durability". `MEMORY.md` regeneration is delegated to `catalog.ts` (Task 6) but called from `put`/`remove` here. We implement `regenerateIndex` as an injected dependency to avoid coupling the test (so this task can run before Task 6 lands fully — the dependency is just a stub).

- [ ] **Step 1: Write the failing test**

```ts
// plugins/llm-memory/test/store.test.ts
import { describe, it, expect, mock } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeStore } from "../store.ts";
import { renderEntry } from "../frontmatter.ts";
import type { MemoryEntry } from "../public.d.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "llm-memory-store-"));
}

function deps(globalDir: string | null, projectDir: string | null) {
  const calls: { dir: string }[] = [];
  return {
    deps: {
      globalDir,
      projectDir,
      regenerateIndex: mock(async (dir: string) => { calls.push({ dir }); }),
      log: () => {},
      now: () => "2026-04-30T12:00:00Z",
    },
    calls,
  };
}

const sample = (over: Partial<MemoryEntry> = {}): MemoryEntry => ({
  name: "x", description: "d", type: "user", scope: "global", body: "body\n", ...over,
});

describe("store.put + get round trip", () => {
  it("writes a global entry and reads it back identical", async () => {
    const g = tmp();
    const { deps: d } = deps(g, null);
    const s = makeStore(d);
    await s.put(sample({ scope: "global" }));
    const back = await s.get("x");
    expect(back).not.toBeNull();
    expect(back!.name).toBe("x");
    expect(back!.body).toBe("body\n");
    expect(back!.created).toBe("2026-04-30T12:00:00Z");
    expect(back!.updated).toBe("2026-04-30T12:00:00Z");
    expect(existsSync(join(g, "x.md"))).toBe(true);
  });
  it("preserves `created` across overwrites and bumps `updated`", async () => {
    const g = tmp();
    const { deps: d } = deps(g, null);
    let now = "2026-04-30T12:00:00Z";
    d.now = () => now;
    const s = makeStore(d);
    await s.put(sample({ scope: "global" }));
    now = "2026-05-01T12:00:00Z";
    await s.put(sample({ scope: "global", body: "new\n" }));
    const back = await s.get("x");
    expect(back!.created).toBe("2026-04-30T12:00:00Z");
    expect(back!.updated).toBe("2026-05-01T12:00:00Z");
    expect(back!.body).toBe("new\n");
  });
  it("project layer wins on collision when scope unspecified", async () => {
    const g = tmp(); const p = tmp();
    const { deps: d } = deps(g, p);
    const s = makeStore(d);
    writeFileSync(join(g, "x.md"), renderEntry(sample({ scope: "global", description: "G" })));
    writeFileSync(join(p, "x.md"), renderEntry(sample({ scope: "project", description: "P" })));
    const back = await s.get("x");
    expect(back!.description).toBe("P");
  });
  it("scope:'project' does NOT fall through to global", async () => {
    const g = tmp(); const p = tmp();
    const { deps: d } = deps(g, p);
    const s = makeStore(d);
    writeFileSync(join(g, "x.md"), renderEntry(sample({ scope: "global" })));
    expect(await s.get("x", { scope: "project" })).toBeNull();
  });
});

describe("store.list + search + filter", () => {
  it("list returns frontmatter only and respects type filter", async () => {
    const g = tmp();
    const { deps: d } = deps(g, null);
    const s = makeStore(d);
    await s.put(sample({ name: "u", type: "user", scope: "global" }));
    await s.put(sample({ name: "f", type: "feedback", scope: "global" }));
    const users = await s.list({ type: "user" });
    expect(users.map((e) => e.name)).toEqual(["u"]);
  });
  it("search matches description substring case-insensitively", async () => {
    const g = tmp();
    const { deps: d } = deps(g, null);
    const s = makeStore(d);
    await s.put(sample({ name: "v", description: "Vault namespace is admin", scope: "global" }));
    const out = await s.search("vault");
    expect(out.map((e) => e.name)).toEqual(["v"]);
  });
  it("ignores entries with parse errors but does not throw", async () => {
    const g = tmp();
    const { deps: d } = deps(g, null);
    writeFileSync(join(g, "broken.md"), "no frontmatter here");
    const s = makeStore(d);
    expect(await s.list()).toEqual([]);
  });
});

describe("store.put atomicity", () => {
  it("regenerates index after every put and remove", async () => {
    const g = tmp();
    const { deps: d, calls } = deps(g, null);
    const s = makeStore(d);
    await s.put(sample({ scope: "global" }));
    await s.remove("x", "global");
    expect(calls.length).toBe(2);
    expect(calls[0].dir).toBe(g);
  });
  it("temp file does not exist after a successful put", async () => {
    const g = tmp();
    const { deps: d } = deps(g, null);
    const s = makeStore(d);
    await s.put(sample({ scope: "global" }));
    const fs = await import("node:fs/promises");
    const after = await fs.readdir(g);
    expect(after.some((e) => e.includes(".tmp."))).toBe(false);
  });
  it("concurrent puts of different names both land", async () => {
    const g = tmp();
    const { deps: d } = deps(g, null);
    const s = makeStore(d);
    await Promise.all([
      s.put(sample({ name: "a", scope: "global" })),
      s.put(sample({ name: "b", scope: "global" })),
    ]);
    expect(existsSync(join(g, "a.md"))).toBe(true);
    expect(existsSync(join(g, "b.md"))).toBe(true);
  });
});

describe("store.readIndex", () => {
  it("returns empty string when MEMORY.md absent", async () => {
    const g = tmp();
    const { deps: d } = deps(g, null);
    const s = makeStore(d);
    expect(await s.readIndex("global")).toBe("");
  });
  it("returns the file body when present", async () => {
    const g = tmp();
    writeFileSync(join(g, "MEMORY.md"), "# hi\n");
    const { deps: d } = deps(g, null);
    const s = makeStore(d);
    expect(await s.readIndex("global")).toBe("# hi\n");
  });
});

describe("store.remove", () => {
  it("is a no-op for a missing entry", async () => {
    const g = tmp();
    const { deps: d } = deps(g, null);
    const s = makeStore(d);
    await s.remove("missing", "global");
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `bun test plugins/llm-memory/test/store.test.ts`

- [ ] **Step 3: Implement `store.ts`**

```ts
import { readFile, writeFile, rename, unlink, mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { listMemoryFiles } from "./paths.ts";
import { parseEntry, renderEntry, validateName } from "./frontmatter.ts";
import type { MemoryEntry, MemoryScope, MemoryStoreService, MemoryType } from "./public.d.ts";

export interface StoreDeps {
  globalDir: string;
  projectDir: string | null;
  /** Re-render MEMORY.md for the given directory. Wired by service.ts to catalog.regenerate. */
  regenerateIndex: (dir: string) => Promise<void>;
  log: (msg: string) => void;
  /** Override-able clock for tests. Returns ISO-8601 string. */
  now?: () => string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function dirFor(deps: StoreDeps, scope: MemoryScope): string | null {
  return scope === "global" ? deps.globalDir : deps.projectDir;
}

async function readEntryFile(dir: string, file: string, scope: MemoryScope): Promise<MemoryEntry | null> {
  let text: string;
  try {
    text = await readFile(join(dir, file), "utf8");
  } catch (err: any) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
  return parseEntry(text, scope);
}

async function readDirEntries(dir: string | null, scope: MemoryScope): Promise<MemoryEntry[]> {
  if (!dir) return [];
  const files = await listMemoryFiles(dir);
  const out: MemoryEntry[] = [];
  for (const f of files) {
    const e = await readEntryFile(dir, f, scope);
    if (e) out.push(e);
  }
  return out;
}

async function atomicWrite(dir: string, name: string, body: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const tempName = `${name}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`;
  const tempPath = join(dir, tempName);
  const finalPath = join(dir, name);
  await writeFile(tempPath, body, { encoding: "utf8", flag: "wx" });
  try {
    await rename(tempPath, finalPath);
  } catch (err) {
    try { await unlink(tempPath); } catch {}
    throw err;
  }
}

export function makeStore(deps: StoreDeps): MemoryStoreService {
  const clock = deps.now ?? nowIso;

  async function get(name: string, opts?: { scope?: MemoryScope }): Promise<MemoryEntry | null> {
    if (!validateName(name)) return null;
    const scopes: MemoryScope[] = opts?.scope ? [opts.scope] : ["project", "global"];
    for (const sc of scopes) {
      const dir = dirFor(deps, sc);
      if (!dir) continue;
      const e = await readEntryFile(dir, `${name}.md`, sc);
      if (e) return e;
    }
    return null;
  }

  async function list(filter?: { type?: MemoryType; scope?: MemoryScope }): Promise<MemoryEntry[]> {
    const scopes: MemoryScope[] = filter?.scope ? [filter.scope] : ["project", "global"];
    const out: MemoryEntry[] = [];
    for (const sc of scopes) {
      out.push(...(await readDirEntries(dirFor(deps, sc), sc)));
    }
    return filter?.type ? out.filter((e) => e.type === filter.type) : out;
  }

  async function search(query: string, opts?: { scope?: MemoryScope; limit?: number }): Promise<MemoryEntry[]> {
    const q = query.toLowerCase();
    const all = await list({ scope: opts?.scope });
    const matches = all.filter(
      (e) => e.name.toLowerCase().startsWith(q) || e.description.toLowerCase().includes(q),
    );
    return matches.slice(0, opts?.limit ?? 5);
  }

  async function put(entry: MemoryEntry): Promise<void> {
    if (!validateName(entry.name)) throw new Error(`memory:store.put: invalid name "${entry.name}"`);
    const dir = dirFor(deps, entry.scope);
    if (!dir) throw new Error(`memory:store.put: scope "${entry.scope}" disabled (projectDir=null)`);
    const existing = await readEntryFile(dir, `${entry.name}.md`, entry.scope);
    const created = existing?.created ?? clock();
    const updated = clock();
    const finalEntry: MemoryEntry = { ...entry, created, updated };
    const text = renderEntry(finalEntry);
    await atomicWrite(dir, `${entry.name}.md`, text);
    await deps.regenerateIndex(dir);
  }

  async function remove(name: string, scope: MemoryScope): Promise<void> {
    if (!validateName(name)) return;
    const dir = dirFor(deps, scope);
    if (!dir) return;
    try {
      await unlink(join(dir, `${name}.md`));
    } catch (err: any) {
      if (err?.code !== "ENOENT") throw err;
      return;
    }
    await deps.regenerateIndex(dir);
  }

  async function readIndex(scope: MemoryScope): Promise<string> {
    const dir = dirFor(deps, scope);
    if (!dir) return "";
    try {
      return await readFile(join(dir, "MEMORY.md"), "utf8");
    } catch (err: any) {
      if (err?.code === "ENOENT") return "";
      throw err;
    }
  }

  return { get, list, search, put, remove, readIndex };
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `bun test plugins/llm-memory/test/store.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-memory/store.ts plugins/llm-memory/test/store.test.ts
git commit -m "feat(llm-memory): atomic store (get/list/search/put/remove/readIndex)"
```

---

## Task 6: `catalog.ts` — render and merge MEMORY.md catalog (Tier 1B)

**Files:**
- Create: `plugins/llm-memory/catalog.ts`
- Create: `plugins/llm-memory/test/catalog.test.ts`

`catalog.ts` owns the markers and the bullet-list rendering. It also exports `regenerateIndex(dir, listEntries)` — the function `store.ts` calls — so the round-trip "preserve user content above the marker" guarantee lives in one place.

- [ ] **Step 1: Write the failing test**

```ts
// plugins/llm-memory/test/catalog.test.ts
import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderCatalog, mergeIntoIndex, regenerateIndex, CATALOG_START, CATALOG_END } from "../catalog.ts";
import type { MemoryEntry } from "../public.d.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "llm-memory-catalog-"));
}

const e = (name: string, description: string): MemoryEntry => ({
  name, description, type: "reference", scope: "global", body: "",
});

describe("renderCatalog", () => {
  it("emits empty markers for zero entries", () => {
    const out = renderCatalog([]);
    expect(out).toBe(`${CATALOG_START}\n${CATALOG_END}`);
  });
  it("emits sorted bullets between markers", () => {
    const out = renderCatalog([e("zeta", "z desc"), e("alpha", "a desc")]);
    expect(out).toBe(
      `${CATALOG_START}\n` +
      `- [alpha](alpha.md) — a desc\n` +
      `- [zeta](zeta.md) — z desc\n` +
      `${CATALOG_END}`,
    );
  });
});

describe("mergeIntoIndex", () => {
  it("appends markers when absent", () => {
    const out = mergeIntoIndex("# Title\n\nUser content.\n", renderCatalog([e("a", "d")]));
    expect(out).toContain("# Title");
    expect(out).toContain(CATALOG_START);
    expect(out).toContain("- [a](a.md) — d");
    expect(out.endsWith(`${CATALOG_END}\n`)).toBe(true);
  });
  it("preserves user content above markers byte-for-byte and replaces between markers", () => {
    const userPart = "# User\n\nNotes.\n\n";
    const prev = `${userPart}${CATALOG_START}\n- [old](old.md) — old\n${CATALOG_END}\n`;
    const out = mergeIntoIndex(prev, renderCatalog([e("new", "fresh")]));
    expect(out.startsWith(userPart)).toBe(true);
    expect(out).toContain("- [new](new.md) — fresh");
    expect(out).not.toContain("old.md");
  });
  it("treats empty prev as user content + appended markers", () => {
    const out = mergeIntoIndex("", renderCatalog([]));
    expect(out).toBe(`${CATALOG_START}\n${CATALOG_END}\n`);
  });
});

describe("regenerateIndex (filesystem)", () => {
  it("creates MEMORY.md when entries exist", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "a.md"), "---\nname: a\ndescription: d\ntype: user\n---\nbody");
    await regenerateIndex(dir);
    const text = readFileSync(join(dir, "MEMORY.md"), "utf8");
    expect(text).toContain("- [a](a.md) — d");
  });
  it("preserves above-marker user content across regenerations", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "MEMORY.md"), `# Mine\n\n${CATALOG_START}\n- [x](x.md) — old\n${CATALOG_END}\n`);
    writeFileSync(join(dir, "a.md"), "---\nname: a\ndescription: d\ntype: user\n---\nbody");
    await regenerateIndex(dir);
    const text = readFileSync(join(dir, "MEMORY.md"), "utf8");
    expect(text.startsWith("# Mine\n\n")).toBe(true);
    expect(text).toContain("- [a](a.md) — d");
  });
  it("temp file does not remain after regeneration", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "a.md"), "---\nname: a\ndescription: d\ntype: user\n---\nbody");
    await regenerateIndex(dir);
    const fs = await import("node:fs/promises");
    const ents = await fs.readdir(dir);
    expect(ents.some((x) => x.includes(".tmp."))).toBe(false);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `bun test plugins/llm-memory/test/catalog.test.ts`

- [ ] **Step 3: Implement `catalog.ts`**

```ts
import { readFile, writeFile, rename, unlink, mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { listMemoryFiles } from "./paths.ts";
import { parseEntry } from "./frontmatter.ts";
import type { MemoryEntry } from "./public.d.ts";

export const CATALOG_START = "<!-- llm-memory:catalog:start -->";
export const CATALOG_END = "<!-- llm-memory:catalog:end -->";

export function renderCatalog(entries: MemoryEntry[]): string {
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  const bullets = sorted.map((e) => `- [${e.name}](${e.name}.md) — ${e.description}`);
  if (bullets.length === 0) return `${CATALOG_START}\n${CATALOG_END}`;
  return `${CATALOG_START}\n${bullets.join("\n")}\n${CATALOG_END}`;
}

export function mergeIntoIndex(prev: string, catalog: string): string {
  const start = prev.indexOf(CATALOG_START);
  const end = prev.indexOf(CATALOG_END);
  if (start === -1 || end === -1 || end < start) {
    // No markers — append catalog block at the end with a newline separator.
    const sep = prev.length === 0 || prev.endsWith("\n") ? "" : "\n";
    return `${prev}${sep}${catalog}\n`;
  }
  const before = prev.slice(0, start);
  const afterEnd = prev.slice(end + CATALOG_END.length);
  // Drop a leading newline in afterEnd to avoid double blank lines.
  const tail = afterEnd.startsWith("\n") ? afterEnd : `\n${afterEnd}`;
  return `${before}${catalog}${tail}`;
}

async function atomicWrite(dir: string, name: string, body: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const tempName = `${name}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`;
  const tempPath = join(dir, tempName);
  const finalPath = join(dir, name);
  await writeFile(tempPath, body, { encoding: "utf8", flag: "wx" });
  try {
    await rename(tempPath, finalPath);
  } catch (err) {
    try { await unlink(tempPath); } catch {}
    throw err;
  }
}

export async function regenerateIndex(dir: string): Promise<void> {
  const files = await listMemoryFiles(dir);
  const entries: MemoryEntry[] = [];
  for (const f of files) {
    let text: string;
    try {
      text = await readFile(join(dir, f), "utf8");
    } catch {
      continue;
    }
    const e = parseEntry(text, "global"); // scope is irrelevant for catalog rendering.
    if (e) entries.push(e);
  }
  let prev = "";
  try {
    prev = await readFile(join(dir, "MEMORY.md"), "utf8");
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw err;
  }
  const out = mergeIntoIndex(prev, renderCatalog(entries));
  await atomicWrite(dir, "MEMORY.md", out);
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `bun test plugins/llm-memory/test/catalog.test.ts`

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-memory/catalog.ts plugins/llm-memory/test/catalog.test.ts
git commit -m "feat(llm-memory): catalog rendering + atomic MEMORY.md regeneration"
```

---

## Task 7: `injection.ts` — render the system-prompt memory block (Tier 1C)

**Files:**
- Create: `plugins/llm-memory/injection.ts`
- Create: `plugins/llm-memory/test/injection.test.ts`

Pure function: takes per-layer index text + entry lists + a byte cap; returns the `<system-reminder>` block string (or `null` if both layers are empty).

- [ ] **Step 1: Write the failing test**

```ts
// plugins/llm-memory/test/injection.test.ts
import { describe, it, expect } from "bun:test";
import { buildMemoryBlock } from "../injection.ts";
import type { MemoryEntry } from "../public.d.ts";

const e = (name: string, description: string, scope: "project" | "global"): MemoryEntry => ({
  name, description, type: "reference", scope, body: "",
});

describe("buildMemoryBlock", () => {
  it("returns null when both layers empty", () => {
    expect(buildMemoryBlock({
      projectIndex: "", globalIndex: "", projectEntries: [], globalEntries: [], projectPath: "/p", byteCap: 2048,
    })).toBeNull();
  });
  it("emits project-only block when global empty", () => {
    const out = buildMemoryBlock({
      projectIndex: "# P\n", globalIndex: "", projectEntries: [e("a", "ad", "project")], globalEntries: [],
      projectPath: "/p", byteCap: 2048,
    });
    expect(out).not.toBeNull();
    expect(out!).toContain("<system-reminder>");
    expect(out!).toContain("# Persistent memory");
    expect(out!).toContain("## Project memory (/p)");
    expect(out!).toContain("# P");
    expect(out!).toContain("- project:a — ad");
    expect(out!).not.toContain("## Global memory");
  });
  it("emits both sections in correct order with both indexes set", () => {
    const out = buildMemoryBlock({
      projectIndex: "# P", globalIndex: "# G",
      projectEntries: [e("p1", "pd", "project")], globalEntries: [e("g1", "gd", "global")],
      projectPath: "/p", byteCap: 2048,
    })!;
    expect(out.indexOf("## Project memory")).toBeLessThan(out.indexOf("## Global memory"));
    expect(out).toContain("- project:p1 — pd");
    expect(out).toContain("- global:g1 — gd");
  });
  it("truncates the catalog (oldest first) when over cap", () => {
    const big = Array.from({ length: 50 }, (_, i) => e(`n${i}`, `desc-${i}`, "global"));
    const out = buildMemoryBlock({
      projectIndex: "", globalIndex: "", projectEntries: [], globalEntries: big,
      projectPath: "/p", byteCap: 256,
    })!;
    expect(out.length).toBeLessThanOrEqual(2 * 256 + 512); // generous wrapper allowance
    expect(out).toContain("[truncated]");
  });
  it("keeps body content but marks truncation when index alone exceeds cap", () => {
    const huge = "x".repeat(5000);
    const out = buildMemoryBlock({
      projectIndex: huge, globalIndex: "", projectEntries: [], globalEntries: [],
      projectPath: "/p", byteCap: 1024,
    })!;
    expect(out).toContain("[truncated]");
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `bun test plugins/llm-memory/test/injection.test.ts`

- [ ] **Step 3: Implement `injection.ts`**

```ts
import type { MemoryEntry } from "./public.d.ts";

export interface BuildBlockInput {
  projectIndex: string;
  globalIndex: string;
  projectEntries: MemoryEntry[];
  globalEntries: MemoryEntry[];
  projectPath: string;
  /** Per-layer cap for the index body (project and global each capped separately). */
  byteCap: number;
}

function truncateBody(text: string, cap: number): { text: string; truncated: boolean } {
  if (text.length <= cap) return { text, truncated: false };
  const marker = "\n... [truncated]";
  const room = Math.max(0, cap - marker.length);
  return { text: text.slice(0, room) + marker, truncated: true };
}

function catalogLines(entries: MemoryEntry[], scopeLabel: string): string[] {
  return entries
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => `- ${scopeLabel}:${e.name} — ${e.description}`);
}

export function buildMemoryBlock(input: BuildBlockInput): string | null {
  const projectHasIndex = input.projectIndex.trim().length > 0;
  const globalHasIndex = input.globalIndex.trim().length > 0;
  const hasProjectEntries = input.projectEntries.length > 0;
  const hasGlobalEntries = input.globalEntries.length > 0;
  if (!projectHasIndex && !globalHasIndex && !hasProjectEntries && !hasGlobalEntries) return null;

  const lines: string[] = [];
  lines.push("<system-reminder>");
  lines.push("# Persistent memory");
  lines.push("");
  lines.push("The following memory has been loaded automatically. Treat it as authoritative");
  lines.push("context about the user, their projects, and prior feedback.");
  lines.push("");

  let truncated = false;

  if (projectHasIndex || hasProjectEntries) {
    lines.push(`## Project memory (${input.projectPath})`);
    lines.push("");
    if (projectHasIndex) {
      const t = truncateBody(input.projectIndex, input.byteCap);
      truncated = truncated || t.truncated;
      lines.push(t.text);
      lines.push("");
    }
  }

  if (globalHasIndex || hasGlobalEntries) {
    lines.push("## Global memory (~/.kaizen/memory/)");
    lines.push("");
    if (globalHasIndex) {
      const t = truncateBody(input.globalIndex, input.byteCap);
      truncated = truncated || t.truncated;
      lines.push(t.text);
      lines.push("");
    }
  }

  if (hasProjectEntries || hasGlobalEntries) {
    lines.push("## Available memory entries (use the `memory_recall` tool to load any of these)");
    lines.push("");
    // Render catalog with oldest-first truncation: prefer entries with the most-recent `updated` if cap is hit.
    const totalCap = input.byteCap; // use one byteCap for the whole catalog
    const projLines = catalogLines(input.projectEntries, "project");
    const globLines = catalogLines(input.globalEntries, "global");
    let combined = [...projLines, ...globLines];
    let used = combined.join("\n").length;
    while (used > totalCap && combined.length > 0) {
      // Remove the first (oldest by name sort) entry to truncate.
      combined.shift();
      truncated = true;
      used = combined.join("\n").length;
    }
    if (combined.length > 0) lines.push(...combined);
    if (truncated) {
      lines.push("");
      lines.push("... [truncated]");
    }
  } else if (truncated) {
    lines.push("");
    lines.push("... [truncated]");
  }

  lines.push("</system-reminder>");
  return lines.join("\n");
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `bun test plugins/llm-memory/test/injection.test.ts`

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-memory/injection.ts plugins/llm-memory/test/injection.test.ts
git commit -m "feat(llm-memory): system-prompt memory block builder with byte cap"
```

---

## Task 8: `tools.ts` — register memory_recall + memory_save (Tier 1C)

**Files:**
- Create: `plugins/llm-memory/tools.ts`
- Create: `plugins/llm-memory/test/tools.test.ts`

Wraps the store as two `ToolHandler`s on `tools:registry`. Best-effort: if no registry is present, `registerTools` returns a no-op unregister and logs.

- [ ] **Step 1: Write the failing test**

```ts
// plugins/llm-memory/test/tools.test.ts
import { describe, it, expect, mock } from "bun:test";
import { registerTools } from "../tools.ts";
import type { MemoryStoreService, MemoryEntry } from "../public.d.ts";

function fakeStore(): { svc: MemoryStoreService; calls: any } {
  const state: MemoryEntry[] = [];
  const calls: any = { put: [] as MemoryEntry[], get: [] as string[] };
  const svc: MemoryStoreService = {
    async get(name) { calls.get.push(name); return state.find((e) => e.name === name) ?? null; },
    async list() { return state; },
    async search(q) { return state.filter((e) => e.description.includes(q) || e.name.startsWith(q)); },
    async put(entry) { calls.put.push(entry); const i = state.findIndex((e) => e.name === entry.name); if (i >= 0) state[i] = entry; else state.push(entry); },
    async remove() {},
    async readIndex() { return ""; },
  };
  return { svc, calls };
}

function fakeRegistry() {
  const registered: { schema: any; handler: any }[] = [];
  return {
    registry: {
      register: mock((schema: any, handler: any) => { registered.push({ schema, handler }); return () => {}; }),
      list: mock(() => registered.map((r) => r.schema)),
      invoke: mock(async () => undefined),
    },
    registered,
  };
}

const ctx: any = { signal: new AbortController().signal, callId: "c1", log: () => {} };

describe("registerTools", () => {
  it("registers two tools tagged memory", () => {
    const { svc } = fakeStore();
    const { registry, registered } = fakeRegistry();
    registerTools(registry as any, svc, { log: () => {}, denyTypes: [] });
    expect(registered.map((r) => r.schema.name).sort()).toEqual(["memory_recall", "memory_save"]);
    for (const r of registered) expect(r.schema.tags).toContain("memory");
  });
  it("memory_recall by names exact-loads and includes body", async () => {
    const { svc } = fakeStore();
    await svc.put({ name: "x", description: "d", type: "user", scope: "global", body: "BODY" });
    const { registry, registered } = fakeRegistry();
    registerTools(registry as any, svc, { log: () => {}, denyTypes: [] });
    const recall = registered.find((r) => r.schema.name === "memory_recall")!.handler;
    const out = await recall({ names: ["x"] }, ctx);
    expect(out.entries[0].body).toBe("BODY");
  });
  it("memory_recall returns structured error for missing names (no throw)", async () => {
    const { svc } = fakeStore();
    const { registry, registered } = fakeRegistry();
    registerTools(registry as any, svc, { log: () => {}, denyTypes: [] });
    const recall = registered.find((r) => r.schema.name === "memory_recall")!.handler;
    const out = await recall({ names: ["nope"] }, ctx);
    expect(out.entries).toEqual([]);
    expect(out.missing).toEqual(["nope"]);
  });
  it("memory_recall fuzzy-match returns up to 5 entries", async () => {
    const { svc } = fakeStore();
    for (let i = 0; i < 10; i++) await svc.put({ name: `n${i}`, description: `vault tip ${i}`, type: "user", scope: "global", body: "" });
    const { registry, registered } = fakeRegistry();
    registerTools(registry as any, svc, { log: () => {}, denyTypes: [] });
    const recall = registered.find((r) => r.schema.name === "memory_recall")!.handler;
    const out = await recall({ query: "vault" }, ctx);
    expect(out.entries.length).toBe(5);
  });
  it("memory_recall respects denyTypes", async () => {
    const { svc } = fakeStore();
    await svc.put({ name: "f", description: "d", type: "feedback", scope: "global", body: "" });
    const { registry, registered } = fakeRegistry();
    registerTools(registry as any, svc, { log: () => {}, denyTypes: ["feedback"] });
    const recall = registered.find((r) => r.schema.name === "memory_recall")!.handler;
    const out = await recall({ names: ["f"] }, ctx);
    expect(out.entries).toEqual([]);
  });
  it("memory_save defaults scope to global and writes the entry", async () => {
    const { svc, calls } = fakeStore();
    const { registry, registered } = fakeRegistry();
    registerTools(registry as any, svc, { log: () => {}, denyTypes: [] });
    const save = registered.find((r) => r.schema.name === "memory_save")!.handler;
    const out = await save({ name: "x", description: "d", content: "B", type: "user" }, ctx);
    expect(out.ok).toBe(true);
    expect(calls.put[0].scope).toBe("global");
  });
  it("memory_save refuses to overwrite without `!` suffix", async () => {
    const { svc } = fakeStore();
    await svc.put({ name: "x", description: "d", type: "user", scope: "global", body: "old" });
    const { registry, registered } = fakeRegistry();
    registerTools(registry as any, svc, { log: () => {}, denyTypes: [] });
    const save = registered.find((r) => r.schema.name === "memory_save")!.handler;
    const out = await save({ name: "x", description: "d", content: "new", type: "user" }, ctx);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/already exists/i);
  });
  it("memory_save with `!` suffix overwrites and strips the suffix", async () => {
    const { svc, calls } = fakeStore();
    await svc.put({ name: "x", description: "d", type: "user", scope: "global", body: "old" });
    const { registry, registered } = fakeRegistry();
    registerTools(registry as any, svc, { log: () => {}, denyTypes: [] });
    const save = registered.find((r) => r.schema.name === "memory_save")!.handler;
    const out = await save({ name: "x!", description: "d", content: "new", type: "user" }, ctx);
    expect(out.ok).toBe(true);
    expect(calls.put.at(-1).name).toBe("x");
    expect(calls.put.at(-1).body).toBe("new");
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `bun test plugins/llm-memory/test/tools.test.ts`

- [ ] **Step 3: Implement `tools.ts`**

```ts
import type { MemoryEntry, MemoryScope, MemoryStoreService, MemoryType } from "./public.d.ts";

// Match the Spec 0 ToolsRegistryService surface without importing it (avoid build-time coupling).
export interface ToolsRegistryLike {
  register(
    schema: { name: string; description: string; parameters: Record<string, unknown>; tags?: string[] },
    handler: (args: any, ctx: { signal: AbortSignal; callId: string; turnId?: string; log: (m: string) => void }) => Promise<unknown>,
  ): () => void;
}

export interface RegisterToolsOptions {
  log: (msg: string) => void;
  denyTypes: MemoryType[];
}

export interface RegisterToolsResult {
  unregister: () => void;
}

export function registerTools(
  registry: ToolsRegistryLike,
  store: MemoryStoreService,
  opts: RegisterToolsOptions,
): RegisterToolsResult {
  const denied = new Set(opts.denyTypes);
  const filterDenied = (es: MemoryEntry[]): MemoryEntry[] => es.filter((e) => !denied.has(e.type));

  const recallHandler = async (args: any, _ctx: any) => {
    const names = Array.isArray(args?.names) ? args.names.map(String) : null;
    const query = typeof args?.query === "string" ? args.query : null;
    const typeFilter: MemoryType | null = typeof args?.type === "string" ? (args.type as MemoryType) : null;

    if (names) {
      const found: MemoryEntry[] = [];
      const missing: string[] = [];
      for (const n of names) {
        const e = await store.get(n);
        if (e && !denied.has(e.type) && (!typeFilter || e.type === typeFilter)) {
          found.push(e);
        } else {
          missing.push(n);
        }
      }
      return {
        entries: found.map(({ name, scope, type, description, body }) => ({ name, scope, type, description, body })),
        missing,
      };
    }
    const matches = await store.search(query ?? "", { limit: 5 });
    let filtered = filterDenied(matches);
    if (typeFilter) filtered = filtered.filter((e) => e.type === typeFilter);
    return {
      entries: filtered.map(({ name, scope, type, description, body }) => ({ name, scope, type, description, body })),
      missing: [],
    };
  };

  const saveHandler = async (args: any, _ctx: any) => {
    const rawName = String(args?.name ?? "");
    const overwrite = rawName.endsWith("!");
    const name = overwrite ? rawName.slice(0, -1) : rawName;
    const description = String(args?.description ?? "");
    const content = String(args?.content ?? "");
    const type: MemoryType = (args?.type ?? "user") as MemoryType;
    const scope: MemoryScope = (args?.scope ?? "global") as MemoryScope;

    const existing = await store.get(name, { scope });
    if (existing && !overwrite) {
      return {
        ok: false,
        error:
          `memory "${name}" already exists. Choose a new name, or pass "${name}!" to overwrite intentionally.`,
      };
    }
    await store.put({ name, description, type, scope, body: content });
    return { ok: true, path: `${scope}:${name}` };
  };

  const u1 = registry.register(
    {
      name: "memory_recall",
      description: "Load the full body of one or more saved memories from llm-memory.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          names: { type: "array", items: { type: "string" } },
          type: { type: "string", enum: ["user", "feedback", "project", "reference"] },
        },
      },
      tags: ["memory", "read"],
    },
    recallHandler,
  );

  const u2 = registry.register(
    {
      name: "memory_save",
      description: "Persist a new memory for future turns. Refuses overwrite unless name ends with `!`.",
      parameters: {
        type: "object",
        required: ["name", "description", "content", "type"],
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          content: { type: "string" },
          type: { type: "string", enum: ["user", "feedback", "project", "reference"] },
          scope: { type: "string", enum: ["project", "global"] },
        },
      },
      tags: ["memory", "write"],
    },
    saveHandler,
  );

  return {
    unregister: () => { try { u1(); } catch {} try { u2(); } catch {} },
  };
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `bun test plugins/llm-memory/test/tools.test.ts`

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-memory/tools.ts plugins/llm-memory/test/tools.test.ts
git commit -m "feat(llm-memory): memory_recall + memory_save tools (registry adapters)"
```

---

## Task 9: `extract.ts` — opt-in auto-extraction heuristic (Tier 1C)

**Files:**
- Create: `plugins/llm-memory/extract.ts`
- Create: `plugins/llm-memory/test/extract.test.ts`

Subscribes to `turn:end` (wired in Task 11). The function exported here, `maybeExtract`, is pure logic plus a side-call dispatch. When `autoExtract: false`, it short-circuits and never calls the driver.

- [ ] **Step 1: Write the failing test**

```ts
// plugins/llm-memory/test/extract.test.ts
import { describe, it, expect, mock } from "bun:test";
import { hasTrigger, maybeExtract } from "../extract.ts";

const TRIGGERS = ["from now on", "remember that", "always", "never", "i prefer", "my "];

describe("hasTrigger", () => {
  it("matches case-insensitively", () => {
    expect(hasTrigger("FROM NOW ON, do X", TRIGGERS)).toBe(true);
    expect(hasTrigger("Remember that the vault namespace is admin.", TRIGGERS)).toBe(true);
    expect(hasTrigger("hello world", TRIGGERS)).toBe(false);
  });
  it("does not match the bare word in a longer one", () => {
    expect(hasTrigger("Iodine is an element.", TRIGGERS)).toBe(false);
  });
});

describe("maybeExtract", () => {
  const baseDeps = () => ({
    config: { autoExtract: true, extractTriggers: TRIGGERS },
    runConversation: mock(async () => ({ finalMessage: { role: "assistant", content: "" }, messages: [], usage: { promptTokens: 0, completionTokens: 0 } })),
    log: () => {},
  });

  it("no-op when autoExtract is false", async () => {
    const d = baseDeps();
    d.config.autoExtract = false;
    await maybeExtract({ reason: "complete", lastUserMessage: "remember that X", turnId: "t1" }, d as any);
    expect(d.runConversation).not.toHaveBeenCalled();
  });
  it("no-op when reason !== complete", async () => {
    const d = baseDeps();
    await maybeExtract({ reason: "cancelled", lastUserMessage: "remember that X", turnId: "t1" }, d as any);
    expect(d.runConversation).not.toHaveBeenCalled();
  });
  it("no-op when no trigger matches", async () => {
    const d = baseDeps();
    await maybeExtract({ reason: "complete", lastUserMessage: "hello world", turnId: "t1" }, d as any);
    expect(d.runConversation).not.toHaveBeenCalled();
  });
  it("dispatches a side conversation with toolFilter when trigger matches", async () => {
    const d = baseDeps();
    await maybeExtract({ reason: "complete", lastUserMessage: "From now on always lower-case my variables.", turnId: "t1" }, d as any);
    expect(d.runConversation).toHaveBeenCalledTimes(1);
    const arg = (d.runConversation.mock.calls[0]![0]) as any;
    expect(arg.toolFilter).toEqual({ names: ["memory_save"] });
    expect(arg.parentTurnId).toBe("t1");
  });
  it("swallows errors from the side call (logs, does not throw)", async () => {
    const log = mock(() => {});
    const d = { ...baseDeps(), log };
    d.runConversation = mock(async () => { throw new Error("driver gone"); });
    await maybeExtract({ reason: "complete", lastUserMessage: "remember that x", turnId: "t1" }, d as any);
    expect(log).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `bun test plugins/llm-memory/test/extract.test.ts`

- [ ] **Step 3: Implement `extract.ts`**

```ts
import type { MemoryConfig } from "./config.ts";

export interface RunConversationFn {
  (input: {
    systemPrompt: string;
    messages: { role: "system" | "user" | "assistant" | "tool"; content: string }[];
    toolFilter?: { tags?: string[]; names?: string[] };
    parentTurnId?: string;
  }): Promise<unknown>;
}

export interface ExtractDeps {
  config: Pick<MemoryConfig, "autoExtract" | "extractTriggers">;
  runConversation: RunConversationFn | null;
  log: (msg: string) => void;
}

export interface TurnEndPayload {
  reason: "complete" | "cancelled" | "error" | string;
  lastUserMessage: string;
  turnId: string;
}

export function hasTrigger(text: string, triggers: string[]): boolean {
  const lower = text.toLowerCase();
  for (const t of triggers) {
    const idx = lower.indexOf(t);
    if (idx === -1) continue;
    // Word-boundary check: previous char (if any) must not be a letter when the
    // trigger starts with a letter — so "iodine" does not match "i ".
    const prev = idx === 0 ? " " : lower[idx - 1]!;
    if (/[a-z]/.test(prev)) continue;
    return true;
  }
  return false;
}

const SIDE_PROMPT = `You are a memory extractor for the user's persistent memory store.
Decide whether the user's most recent message contains a durable preference,
fact, or correction worth remembering across sessions. If yes, call the
\`memory_save\` tool exactly once with a concise \`name\`, a one-line
\`description\` (<200 chars), the relevant \`content\`, and an appropriate
\`type\` ("user" | "feedback" | "project" | "reference"). If no, do nothing.
Never reply with prose; only a tool call or no output at all.`;

export async function maybeExtract(payload: TurnEndPayload, deps: ExtractDeps): Promise<void> {
  if (!deps.config.autoExtract) return;
  if (payload.reason !== "complete") return;
  if (!hasTrigger(payload.lastUserMessage, deps.config.extractTriggers)) return;
  if (!deps.runConversation) {
    deps.log("llm-memory: autoExtract enabled but driver:run-conversation not available; skipping");
    return;
  }
  try {
    await deps.runConversation({
      systemPrompt: SIDE_PROMPT,
      messages: [{ role: "user", content: payload.lastUserMessage }],
      toolFilter: { names: ["memory_save"] },
      parentTurnId: payload.turnId,
    });
  } catch (err) {
    deps.log(`llm-memory: extract side-call failed: ${(err as Error).message}`);
  }
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `bun test plugins/llm-memory/test/extract.test.ts`

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-memory/extract.ts plugins/llm-memory/test/extract.test.ts
git commit -m "feat(llm-memory): opt-in auto-extraction heuristic + side-call dispatch"
```

---

## Task 10: `service.ts` — assemble MemoryStoreService for `memory:store` (Tier 1D)

**Files:**
- Create: `plugins/llm-memory/service.ts`
- Create: `plugins/llm-memory/test/service.test.ts`

Wires `store.ts` to `catalog.regenerateIndex` and exposes `makeMemoryStore(config, deps)`. This is the function `index.ts` calls to obtain the service to provide.

- [ ] **Step 1: Write the failing test**

```ts
// plugins/llm-memory/test/service.test.ts
import { describe, it, expect } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeMemoryStore } from "../service.ts";
import { CATALOG_START } from "../catalog.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "llm-memory-svc-"));
}

describe("makeMemoryStore (integration)", () => {
  it("put writes file AND regenerates MEMORY.md", async () => {
    const g = tmp();
    const svc = makeMemoryStore({ globalDir: g, projectDir: null, log: () => {} });
    await svc.put({ name: "x", description: "d", type: "user", scope: "global", body: "B" });
    expect(existsSync(join(g, "x.md"))).toBe(true);
    const idx = readFileSync(join(g, "MEMORY.md"), "utf8");
    expect(idx).toContain(CATALOG_START);
    expect(idx).toContain("- [x](x.md) — d");
  });
  it("readIndex returns the regenerated MEMORY.md", async () => {
    const g = tmp();
    const svc = makeMemoryStore({ globalDir: g, projectDir: null, log: () => {} });
    await svc.put({ name: "x", description: "d", type: "user", scope: "global", body: "" });
    const idx = await svc.readIndex("global");
    expect(idx).toContain("- [x](x.md) — d");
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `bun test plugins/llm-memory/test/service.test.ts`

- [ ] **Step 3: Implement `service.ts`**

```ts
import { regenerateIndex } from "./catalog.ts";
import { makeStore } from "./store.ts";
import type { MemoryStoreService } from "./public.d.ts";

export interface MemoryServiceDeps {
  globalDir: string;
  projectDir: string | null;
  log: (msg: string) => void;
}

export function makeMemoryStore(deps: MemoryServiceDeps): MemoryStoreService {
  return makeStore({
    globalDir: deps.globalDir,
    projectDir: deps.projectDir,
    regenerateIndex: (dir: string) => regenerateIndex(dir),
    log: deps.log,
  });
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `bun test plugins/llm-memory/test/service.test.ts`

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-memory/service.ts plugins/llm-memory/test/service.test.ts
git commit -m "feat(llm-memory): assemble memory:store service (store + catalog wired)"
```

---

## Task 11: `index.ts` — wire setup (config, service, event, tools)

**Files:**
- Modify: `plugins/llm-memory/index.ts` (replace placeholder body)

`setup` does, in order: load config → resolve dirs → ensure dirs → sweep stale `.tmp.*` → build the service → provide it → subscribe `llm:before-call` → register tools (best-effort) → subscribe `turn:end` (only if `autoExtract`).

- [ ] **Step 1: Replace placeholder index**

```ts
import { homedir } from "node:os";
import type { KaizenPlugin } from "kaizen/types";
import type { LLMRequest } from "llm-events/public";
import { loadConfig, realDeps } from "./config.ts";
import { resolveDirs, ensureDir, sweepStaleTempFiles } from "./paths.ts";
import { makeMemoryStore } from "./service.ts";
import { buildMemoryBlock } from "./injection.ts";
import { registerTools } from "./tools.ts";
import { maybeExtract } from "./extract.ts";
import type { MemoryStoreService } from "./public.d.ts";

const plugin: KaizenPlugin = {
  name: "llm-memory",
  apiVersion: "3.0.0",
  permissions: { tier: "trusted" },
  services: {
    provides: ["memory:store"],
    consumes: ["llm-events:vocabulary", "tools:registry", "driver:run-conversation"],
  },

  async setup(ctx) {
    const log = (m: string) => ctx.log(m);
    const config = await loadConfig(realDeps(log));
    const { globalDir, projectDir } = resolveDirs({
      home: homedir(),
      cwd: process.cwd(),
      config: { globalDir: config.globalDir, projectDir: config.projectDir },
    });

    await ensureDir(globalDir);
    if (projectDir) {
      // Project directory is created lazily on first put when the user opts in.
      // Sweep stale temp files only if it already exists.
    }
    await sweepStaleTempFiles(globalDir, config.staleTempMs);
    if (projectDir) await sweepStaleTempFiles(projectDir, config.staleTempMs);

    const store = makeMemoryStore({ globalDir, projectDir, log });
    ctx.defineService("memory:store", { description: "File-backed persistent memory store." });
    ctx.provideService<MemoryStoreService>("memory:store", store);

    // Injection hook: append a memory block to request.systemPrompt.
    ctx.on("llm:before-call", async (payload: { request: LLMRequest }) => {
      const projectIdx = projectDir ? await store.readIndex("project") : "";
      const globalIdx = await store.readIndex("global");
      const denyTypes = new Set(config.denyTypes);
      const projectEntries = projectDir
        ? (await store.list({ scope: "project" })).filter((e) => !denyTypes.has(e.type))
        : [];
      const globalEntries = (await store.list({ scope: "global" })).filter((e) => !denyTypes.has(e.type));
      const block = buildMemoryBlock({
        projectIndex: projectIdx,
        globalIndex: globalIdx,
        projectEntries,
        globalEntries,
        projectPath: projectDir ?? "(disabled)",
        byteCap: config.injectionByteCap,
      });
      if (!block) return;
      const prev = payload.request.systemPrompt ?? "";
      payload.request.systemPrompt = prev.length === 0 ? block : `${prev}\n\n${block}`;
    });

    // Tools registration (best-effort; the tools registry may not exist in A-tier harnesses).
    const registry = ctx.useService<any>("tools:registry");
    if (registry) {
      registerTools(registry, store, { log, denyTypes: config.denyTypes });
    } else {
      log("llm-memory: tools:registry not available; memory_recall/memory_save not registered");
    }

    // Auto-extraction (off by default).
    if (config.autoExtract) {
      ctx.on("turn:end", async (payload: { reason: string; lastUserMessage?: string; turnId?: string }) => {
        if (!payload.lastUserMessage || !payload.turnId) return;
        const driver = ctx.useService<{ runConversation: any }>("driver:run-conversation");
        await maybeExtract(
          { reason: payload.reason, lastUserMessage: payload.lastUserMessage, turnId: payload.turnId },
          { config, runConversation: driver?.runConversation ?? null, log },
        );
      });
    }
  },
};

export default plugin;
```

- [ ] **Step 2: Add an integration test for setup wiring**

Append to `plugins/llm-memory/test/index.test.ts`:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock } from "bun:test";
import plugin from "../index.ts";

function makeCtx(env: Record<string, string | undefined> = {}) {
  const services: Record<string, unknown> = {};
  const handlers: Record<string, Function[]> = {};
  return {
    log: mock(() => {}),
    defineService: mock(() => {}),
    provideService: mock((name: string, impl: unknown) => { services[name] = impl; }),
    consumeService: mock(() => {}),
    useService: mock((name: string) => services[name]),
    on: mock((evt: string, h: Function) => { (handlers[evt] ??= []).push(h); }),
    emit: mock(async () => []),
    defineEvent: mock(() => {}),
    secrets: { get: mock(async () => undefined), refresh: mock(async () => undefined) },
    services,
    handlers,
  } as any;
}

describe("llm-memory setup wiring", () => {
  it("provides memory:store and subscribes llm:before-call", async () => {
    const home = mkdtempSync(join(tmpdir(), "llm-memory-home-"));
    const orig = process.env.HOME;
    process.env.HOME = home;
    try {
      const ctx = makeCtx();
      await plugin.setup(ctx);
      expect(ctx.services["memory:store"]).toBeTruthy();
      expect(ctx.handlers["llm:before-call"]?.length).toBe(1);
    } finally {
      if (orig !== undefined) process.env.HOME = orig;
    }
  });
  it("does not subscribe turn:end when autoExtract default (false)", async () => {
    const home = mkdtempSync(join(tmpdir(), "llm-memory-home-"));
    const orig = process.env.HOME;
    process.env.HOME = home;
    try {
      const ctx = makeCtx();
      await plugin.setup(ctx);
      expect(ctx.handlers["turn:end"]).toBeUndefined();
    } finally {
      if (orig !== undefined) process.env.HOME = orig;
    }
  });
});
```

- [ ] **Step 3: Run all tests**

Run: `bun test plugins/llm-memory/`
Expected: every test PASSes.

- [ ] **Step 4: Commit**

```bash
git add plugins/llm-memory/index.ts plugins/llm-memory/test/index.test.ts
git commit -m "feat(llm-memory): wire setup() — service, injection hook, tools, opt-in extract"
```

---

## Task 12: `public.d.ts` — verify shape

**Files:**
- Verify: `plugins/llm-memory/public.d.ts`

The placeholder from Task 1 already contains the public types. Verify no shape drift.

- [ ] **Step 1: Verify file content**

Run: `cat plugins/llm-memory/public.d.ts`
Expected: matches Task 1 Step 4 exactly. If divergent, restore.

- [ ] **Step 2: Acceptance grep — no internal types leak**

Run: `grep -nE "interface (StoreDeps|ConfigDeps|MemoryConfig|ToolsRegistryLike|ExtractDeps|MemoryServiceDeps)" plugins/llm-memory/public.d.ts`
Expected: NO matches.

- [ ] **Step 3: Acceptance grep — only ~/.kaizen/memory and <project>/.kaizen/memory paths used**

Run: `grep -nE '~/?\\.claude|/\\.claude/' plugins/llm-memory/`
Expected: NO matches outside the README's portability note. (If hits show up in source, fix.)

- [ ] **Step 4: Type-check**

Run: `bun --bun tsc --noEmit -p plugins/llm-memory/tsconfig.json plugins/llm-memory/index.ts plugins/llm-memory/public.d.ts`
Expected: no diagnostics.

- [ ] **Step 5: Commit (if any drift was fixed)**

```bash
git add plugins/llm-memory/public.d.ts
git commit -m "chore(llm-memory): verify public.d.ts surface" || echo "no changes"
```

---

## Task 13: Fixtures — Claude-Code-compatible directory portability

**Files:**
- Create: `plugins/llm-memory/test/fixtures/claude-code-style-memory-dir/MEMORY.md`
- Create: `plugins/llm-memory/test/fixtures/claude-code-style-memory-dir/bun_git_dep_semver.md`
- Create: `plugins/llm-memory/test/fixtures/claude-code-style-memory-dir/vault_namespace.md`
- Create: `plugins/llm-memory/test/fixtures/hand-authored-memory.md`
- Create: `plugins/llm-memory/test/fixtures.test.ts`

The acceptance criterion "a pre-existing Claude-Code memory directory copied into `~/.kaizen/memory/` is read without modification" demands a real on-disk fixture replayed through the store.

- [ ] **Step 1: Write `bun_git_dep_semver.md`**

```
---
name: bun_git_dep_semver
description: Bun #semver over git URLs unsupported — pin literal tag/SHA
type: reference
created: 2026-04-15T10:23:00Z
updated: 2026-04-30T08:11:00Z
---

# Body

Pin the literal tag or SHA, not a `#semver:^x.y.z` constraint.
```

- [ ] **Step 2: Write `vault_namespace.md`**

```
---
name: vault_namespace
description: Vault namespace is "admin"
type: reference
---

# Body

Use `admin` for all OIDC operations.
```

- [ ] **Step 3: Write `MEMORY.md`** (Claude-Code-style; markers absent on purpose so we exercise the "append markers on first write" path):

```
# User Profile

Free-form user-authored notes preserved across regenerations.

- [bun_git_dep_semver](bun_git_dep_semver.md) — Bun #semver over git URLs unsupported
- [vault_namespace](vault_namespace.md) — Vault namespace is "admin"
```

- [ ] **Step 4: Write `hand-authored-memory.md`** (no created/updated):

```
---
name: hand_authored
description: User edited this directly with vim
type: user
---

# Body

Loaded successfully even without timestamps.
```

- [ ] **Step 5: Write `fixtures.test.ts`**

```ts
import { describe, it, expect } from "bun:test";
import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeMemoryStore } from "../service.ts";
import { CATALOG_START, CATALOG_END } from "../catalog.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "llm-memory-fix-"));
}

describe("Claude-Code portability", () => {
  it("reads a pre-existing memory directory without losing data", async () => {
    const dest = tmp();
    cpSync(join(import.meta.dir, "fixtures", "claude-code-style-memory-dir"), dest, { recursive: true });
    const svc = makeMemoryStore({ globalDir: dest, projectDir: null, log: () => {} });
    const list = await svc.list();
    expect(list.map((e) => e.name).sort()).toEqual(["bun_git_dep_semver", "vault_namespace"]);
    const e = await svc.get("vault_namespace");
    expect(e!.description).toBe('Vault namespace is "admin"');
    expect(e!.created).toBeUndefined();
  });

  it("append-on-first-write adds markers without destroying user content", async () => {
    const dest = tmp();
    cpSync(join(import.meta.dir, "fixtures", "claude-code-style-memory-dir"), dest, { recursive: true });
    const svc = makeMemoryStore({ globalDir: dest, projectDir: null, log: () => {} });
    await svc.put({ name: "fresh", description: "new entry", type: "user", scope: "global", body: "hi" });
    const idx = readFileSync(join(dest, "MEMORY.md"), "utf8");
    expect(idx.startsWith("# User Profile")).toBe(true);
    expect(idx).toContain(CATALOG_START);
    expect(idx).toContain(CATALOG_END);
    expect(idx).toContain("- [fresh](fresh.md) — new entry");
  });

  it("hand-authored entry without created/updated parses correctly", async () => {
    const dest = tmp();
    const fs = await import("node:fs/promises");
    await fs.copyFile(
      join(import.meta.dir, "fixtures", "hand-authored-memory.md"),
      join(dest, "hand_authored.md"),
    );
    const svc = makeMemoryStore({ globalDir: dest, projectDir: null, log: () => {} });
    const e = await svc.get("hand_authored");
    expect(e).not.toBeNull();
    expect(e!.body).toContain("Loaded successfully");
  });
});
```

- [ ] **Step 6: Run all plugin tests**

Run: `bun test plugins/llm-memory/`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add plugins/llm-memory/test/fixtures plugins/llm-memory/test/fixtures.test.ts
git commit -m "test(llm-memory): Claude-Code portability fixtures + hand-authored entry"
```

---

## Task 14: Marketplace catalog update

**Files:**
- Modify: `.kaizen/marketplace.json`

- [ ] **Step 1: Add the `llm-memory` entry**

Insert after the existing `openai-llm` entry, before the `claude-wrapper` harness:

```jsonc
    {
      "kind": "plugin",
      "name": "llm-memory",
      "description": "File-backed persistent memory: memory:store service + memory_recall/memory_save tools + llm:before-call injection.",
      "categories": ["memory"],
      "versions": [{ "version": "0.1.0", "source": { "type": "file", "path": "plugins/llm-memory" } }]
    },
```

- [ ] **Step 2: Validate JSON**

Run: `bun -e "JSON.parse(require('node:fs').readFileSync('.kaizen/marketplace.json','utf8'))"`
Expected: no error.

- [ ] **Step 3: Final test sweep**

Run: `bun test plugins/llm-memory`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add .kaizen/marketplace.json
git commit -m "chore(marketplace): publish llm-memory@0.1.0"
```

---

## Spec coverage summary

| Spec section | Task |
|---|---|
| Plugin shape (KaizenPlugin, trusted tier, services list) | Tasks 1, 11 |
| Storage layout (`<project>/.kaizen/memory`, `~/.kaizen/memory`) | Tasks 2, 11 |
| `globalDir` / `projectDir` overrides incl. `null` to disable project | Tasks 2, 4 |
| File format (frontmatter required + optional fields) | Task 3 |
| `MEMORY.md` index, marker comments, append-on-first-write | Task 6, 13 |
| Injection contract (`<system-reminder>`, ordering, blank-line separator) | Task 7 |
| Byte-cap truncation (catalog oldest-first; body never silently dropped) | Task 7 |
| `memory:store` service interface (get/list/search/put/remove/readIndex) | Tasks 5, 10 |
| `memory_recall` tool (names, query, type filter, denyTypes) | Task 8 |
| `memory_save` tool (default scope=global, `!`-suffix overwrite) | Task 8 |
| Atomic writes (temp + rename) | Tasks 5, 6 |
| `MEMORY.md` regeneration is atomic | Task 6 |
| `.tmp.*` sweeper at startup | Tasks 2, 11 |
| Auto-extraction (opt-in, off by default, heuristic + side call) | Task 9, 11 |
| `denyTypes` excludes from injection AND `memory_recall` | Tasks 8, 11 |
| Configuration keys (globalDir/projectDir/injectionByteCap/autoExtract/extractTriggers/denyTypes) | Task 4 |
| Permissions: trusted, no network, no spawn | Task 1 (manifest) |
| Test plan items 1-7 (injection, round-trip, type filtering, atomicity, tool integration, catalog rendering, service contract) | Tasks 5-8, 13 |
| Test plan item 8 (auto-extraction) | Task 9 |
| Acceptance: builds and passes own tests | Tasks 1-13 |
| Acceptance: `memory:store` callable from another plugin | Task 11 (provideService) + smoke verified in Task 11 test |
| Acceptance: `memory_recall`/`memory_save` discoverable by `tools:registry.list({ tags: ["memory"] })` | Task 8 |
| Acceptance: pre-existing Claude-Code dir parses unmodified | Task 13 |
| Acceptance: README documents directory choice, autoExtract opt-in, privacy, .gitignore | Task 1 |
| Acceptance: marketplace updated | Task 14 |

## Self-review notes (applied)

- The `regenerateIndex` → `store` dependency is inverted via injection (`StoreDeps.regenerateIndex`) so `store.test.ts` does not transitively require `catalog.ts`; the real wire-up happens in `service.ts` (Task 10). This keeps Tier 1B parallelizable.
- The `memory_save` overwrite gesture (`name` ending in `!`) is implemented by stripping the suffix before validation in `tools.ts`; `validateName` itself rejects `!` (verified by test in Task 3).
- `denyTypes` enforcement is centralised in two callsites — the `llm:before-call` subscriber (Task 11) and `tools.ts` (Task 8) — matching the spec's "from injection AND from `memory_recall`" wording.
- Project layer is read-only when `projectDir === null`; `put({ scope: "project" })` throws rather than silently writing to global. Test in Task 5 covers the absence of fall-through on `get({ scope: "project" })`; the throw-on-disabled put is enforced in `store.ts`.
- The injection block goes into `request.systemPrompt`, not `messages[]`, so it composes cleanly with `tool-dispatch:strategy.systemPromptAppend` from Spec 0 (Spec 9 § "Injection contract" rationale).
- Auto-extraction's "side call" uses `driver:run-conversation` via `ctx.useService` — best-effort, with a clear log if the service is absent (e.g. an A-tier harness without `llm-driver`).
- Atomic write uses `wx` flag on the temp file so a colliding random suffix throws rather than silently overwriting another in-flight writer's temp.
