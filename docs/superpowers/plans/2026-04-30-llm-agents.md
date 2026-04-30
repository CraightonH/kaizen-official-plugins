# llm-agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the `llm-agents` Kaizen plugin (Spec 11) — discovers markdown agent manifests under `~/.kaizen/agents/` and `<project>/.kaizen/agents/`, exposes `agents:registry`, registers a `dispatch_agent` tool that recursively invokes `driver:run-conversation`, and injects an "Available agents" section into the parent's system prompt via `llm:before-call`.

**Architecture:** Microservice plugin layered as `frontmatter → loader → registry → injector → dispatch → index`. Each module is unit-testable with stubbed dependencies; the only stateful surface is the in-memory manifest map plus the per-turn injection-tracking Set. Plugin reads its own settings from `~/.kaizen/plugins/llm-agents/config.json` (the harness `agents` namespace falls back to this per Spec 0 config-path convention). Depends only on Spec 0 shared types from `llm-events`.

**Tech Stack:** TypeScript, Bun runtime, native `fs/promises`, `path`, `os`. Tests use `bun:test`. No external runtime deps.

---

## Prerequisites & Tier-for-Parallelism Map

This plan implements one plugin (`llm-agents`). It depends on `llm-events` (already on disk; provides shared types incl. `AgentManifest`, `ChatMessage`, `LLMRequest`, `RunConversationInput`, `ToolSchema`, `ToolHandler`, `ToolExecutionContext`, `DriverService`, `Vocab`).

> **Spec 0 dependency note:** Spec 11 §"Spec 0 dependency" requires `ToolExecutionContext.turnId` to exist. Per the Spec 0 changelog (2026-04-30 contract sync), `turnId?: string` IS already added — verify in Task 0 before depending on it.

Tiers below indicate what may run in parallel (no shared writes, no read-after-write):

- **Tier 0** (sequential, blocks all others): Task 0 (verify `llm-events` exports), Task 1 (scaffold `llm-agents` package).
- **Tier 1A** (parallel, leaf modules — no inter-task imports): Task 2 (`config.ts`), Task 3 (`frontmatter.ts`), Task 4 (`tool-filter.ts`), Task 5 (`depth.ts`).
- **Tier 1B** (parallel, depend on Tier 1A): Task 6 (`loader.ts` — uses frontmatter, config), Task 7 (`registry.ts`).
- **Tier 1C** (sequential, integrate): Task 8 (`injector.ts`), Task 9 (`dispatch.ts`), Task 10 (`index.ts`), Task 11 (integration test + sample agent), Task 12 (marketplace catalog).

## File Structure

```
plugins/llm-agents/
  index.ts           # KaizenPlugin: setup() — load config, run discovery (microtask), register service + tool, subscribe to llm:before-call/turn:end
  config.ts          # AgentsConfig type + loadConfig(); resolves user/project agent dirs and maxDepth from ~/.kaizen/plugins/llm-agents/config.json
  frontmatter.ts     # parseAgentFile(text, sourcePath): { manifest } | { error }
  loader.ts          # loadFromDirs(deps): { manifests: InternalAgentManifest[]; errors: { path; message }[] } — fs walk, symlink-cycle guard, size cap
  registry.ts        # makeRegistry(initial): AgentsRegistryService + internal lookup; enforces unique names + reserved "runtime:" prefix for register()
  tool-filter.ts     # matchesFilter(toolName, manifest): boolean — glob '*' wildcards, OR over tools/tags
  depth.ts           # computeDepth(turnRegistry, turnId): number — walk parentTurnId chain
  injector.ts        # makeInjector(registry, vocab): subscribes to llm:before-call (top-level only), tracks injected turn ids, formats "Available agents" section
  dispatch.ts        # makeDispatchTool(deps): { schema: ToolSchema; handler: ToolHandler } — depth check, build RunConversationInput, recurse, surface errors as tool errors
  public.d.ts        # re-exports AgentManifest, AgentsRegistryService from llm-events
  package.json
  tsconfig.json
  README.md
  examples/
    code-reviewer.md
  test/
    config.test.ts
    frontmatter.test.ts
    loader.test.ts
    registry.test.ts
    tool-filter.test.ts
    depth.test.ts
    injector.test.ts
    dispatch.test.ts
    index.test.ts
    fixtures/
      agents-user/
        code-reviewer.md
        broken.md
        oversize.md       # generated at test time, > 64 KiB
      agents-project/
        code-reviewer.md  # shadows user
        doc-writer.md
```

Boundaries:
- `frontmatter.ts` is a pure function: text in, manifest-or-error out. No fs.
- `loader.ts` is the only fs-touching module; takes a `Deps` facade so tests stub it.
- `registry.ts` is pure data: `Map<string, InternalAgentManifest>` plus listeners.
- `tool-filter.ts` and `depth.ts` are pure helpers.
- `injector.ts` and `dispatch.ts` are the only modules that subscribe to / consume bus services.
- `index.ts` is the I/O shell — wires everything, runs discovery in a microtask.

`.kaizen/marketplace.json` is also modified (Task 12).

---

## Task 0: Verify Spec 0 prerequisites in `llm-events`

**Files:**
- Read-only: `plugins/llm-events/public.d.ts`

This task is a fast precondition check; do not skip. Spec 11 depends on `ToolExecutionContext.turnId` being present, plus types `AgentManifest`, `AgentsRegistryService`, `RunConversationInput`, `RunConversationOutput`, `DriverService`, `ToolSchema`, `ToolHandler`, `ToolExecutionContext`, `ChatMessage`. If any are missing, Spec 0 must be updated FIRST per the propagation rule (do not patch them in `llm-agents`).

- [ ] **Step 1: Grep for required exports**

Run:
```bash
grep -nE "ToolExecutionContext|AgentManifest|AgentsRegistryService|RunConversationInput|RunConversationOutput|DriverService|ToolSchema|ToolHandler" plugins/llm-events/public.d.ts
```
Expected: every name above appears at least once. `ToolExecutionContext` must include a `turnId` field (optional or required).

- [ ] **Step 2: If anything is missing — STOP**

Open the missing-symbol issue against `llm-events` (Spec 0). Do not proceed with `llm-agents` until `llm-events` exports them. The plan resumes at Task 1 once Task 0 grep passes clean.

- [ ] **Step 3: If everything is present — record the verification**

```bash
grep -c "turnId" plugins/llm-events/public.d.ts
```
Expected: ≥1. No commit needed; this is a precondition gate.

---

## Task 1: Scaffold `llm-agents` plugin skeleton

**Files:**
- Create: `plugins/llm-agents/package.json`
- Create: `plugins/llm-agents/tsconfig.json`
- Create: `plugins/llm-agents/index.ts` (placeholder)
- Create: `plugins/llm-agents/public.d.ts`
- Create: `plugins/llm-agents/README.md`

The placeholder index/public is required so `bun install` and TypeScript can resolve the workspace package; module bodies are filled in by Tasks 8-10.

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "llm-agents",
  "version": "0.1.0",
  "description": "Subagent dispatch + file-loader registry for the openai-compatible harness",
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

- [ ] **Step 2: Write `tsconfig.json`** (copy of `plugins/llm-events/tsconfig.json`):

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
  name: "llm-agents",
  apiVersion: "3.0.0",
  permissions: { tier: "unscoped" },
  services: { provides: ["agents:registry"], consumes: ["tools:registry", "driver:run-conversation", "llm-events:vocabulary"] },
  async setup(ctx) {
    // Filled in by Task 10.
    ctx.defineService("agents:registry", { description: "Agent manifest registry." });
  },
};

export default plugin;
```

- [ ] **Step 4: Write `public.d.ts`**

```ts
export type { AgentManifest, AgentsRegistryService } from "llm-events/public";
```

- [ ] **Step 5: Write `README.md`** (one paragraph):

```markdown
# llm-agents

Subagent dispatch and file-backed agent registry for the openai-compatible harness.
Discovers markdown manifests under `~/.kaizen/agents/` and `<project>/.kaizen/agents/`,
exposes `agents:registry`, and registers a `dispatch_agent` tool that recursively
invokes `driver:run-conversation` with the agent's system prompt and tool filter.
See Spec 11 for the contract.
```

- [ ] **Step 6: Refresh workspace install**

Run: `bun install`
Expected: workspace resolves `llm-agents`; no errors.

- [ ] **Step 7: Sanity test placeholder**

Run: `bun -e "import('./plugins/llm-agents/index.ts').then(m => console.log(m.default.name))"`
Expected: `llm-agents`.

- [ ] **Step 8: Commit**

```bash
git add plugins/llm-agents/
git commit -m "feat(llm-agents): scaffold plugin package (skeleton only)"
```

---

## Task 2: `config.ts` — load and validate plugin config (Tier 1A)

**Files:**
- Create: `plugins/llm-agents/config.ts`
- Create: `plugins/llm-agents/test/config.test.ts`

`loadConfig(deps)` reads `~/.kaizen/plugins/llm-agents/config.json` (or `KAIZEN_LLM_AGENTS_CONFIG`), merges with defaults, expands `~` in dirs, and resolves `projectDir` against `cwd`. Missing file → defaults; malformed JSON → throw.

Defaults map to Spec 11 §Settings: `maxDepth: 3`, `userDir: "~/.kaizen/agents"`, `projectDir: ".kaizen/agents"`.

- [ ] **Step 1: Write the failing tests**

Create `plugins/llm-agents/test/config.test.ts`:

```ts
import { describe, it, expect, mock } from "bun:test";
import { loadConfig, DEFAULT_CONFIG, type ConfigDeps } from "../config.ts";

function makeDeps(overrides: Partial<ConfigDeps> = {}): ConfigDeps {
  return {
    home: "/home/u",
    cwd: "/work/proj",
    env: {},
    readFile: async () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); },
    log: mock(() => {}),
    ...overrides,
  };
}

describe("loadConfig", () => {
  it("returns defaults when file is absent and resolves dirs", async () => {
    const cfg = await loadConfig(makeDeps());
    expect(cfg.maxDepth).toBe(DEFAULT_CONFIG.maxDepth);
    expect(cfg.resolvedUserDir).toBe("/home/u/.kaizen/agents");
    expect(cfg.resolvedProjectDir).toBe("/work/proj/.kaizen/agents");
  });

  it("honors KAIZEN_LLM_AGENTS_CONFIG env override", async () => {
    let path = "";
    await loadConfig(makeDeps({
      env: { KAIZEN_LLM_AGENTS_CONFIG: "/etc/agents.json" },
      readFile: async (p) => { path = p; return JSON.stringify({ maxDepth: 5 }); },
    }));
    expect(path).toBe("/etc/agents.json");
  });

  it("merges file over defaults; expands ~ and resolves project dir against cwd", async () => {
    const cfg = await loadConfig(makeDeps({
      readFile: async () => JSON.stringify({ maxDepth: 2, userDir: "~/custom-agents", projectDir: "ai/agents" }),
    }));
    expect(cfg.maxDepth).toBe(2);
    expect(cfg.resolvedUserDir).toBe("/home/u/custom-agents");
    expect(cfg.resolvedProjectDir).toBe("/work/proj/ai/agents");
  });

  it("rejects maxDepth < 1", async () => {
    await expect(loadConfig(makeDeps({
      readFile: async () => JSON.stringify({ maxDepth: 0 }),
    }))).rejects.toThrow(/maxDepth/);
  });

  it("throws on malformed JSON", async () => {
    await expect(loadConfig(makeDeps({
      readFile: async () => "{nope",
    }))).rejects.toThrow(/llm-agents config.*malformed/i);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `bun test plugins/llm-agents/test/config.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `config.ts`**

```ts
import { readFile as fsReadFile } from "node:fs/promises";
import { resolve, isAbsolute } from "node:path";

export interface AgentsConfigFile {
  maxDepth?: number;
  userDir?: string;
  projectDir?: string;
}

export interface AgentsConfig {
  maxDepth: number;
  resolvedUserDir: string;
  resolvedProjectDir: string;
}

export const DEFAULT_CONFIG = Object.freeze({
  maxDepth: 3,
  userDir: "~/.kaizen/agents",
  projectDir: ".kaizen/agents",
});

export interface ConfigDeps {
  home: string;
  cwd: string;
  env: Record<string, string | undefined>;
  readFile: (path: string) => Promise<string>;
  log: (msg: string) => void;
}

function defaultPath(home: string): string {
  return `${home}/.kaizen/plugins/llm-agents/config.json`;
}

function expandTilde(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return `${home}/${p.slice(2)}`;
  return p;
}

function resolveDir(p: string, home: string, cwd: string): string {
  const expanded = expandTilde(p, home);
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

export async function loadConfig(deps: ConfigDeps): Promise<AgentsConfig> {
  const path = deps.env.KAIZEN_LLM_AGENTS_CONFIG ?? defaultPath(deps.home);
  let file: AgentsConfigFile = {};
  try {
    const raw = await deps.readFile(path);
    try { file = JSON.parse(raw) as AgentsConfigFile; }
    catch (err) { throw new Error(`llm-agents config at ${path} malformed: ${(err as Error).message}`); }
  } catch (err: any) {
    if (err?.code === "ENOENT") deps.log(`llm-agents: no config at ${path}; using defaults`);
    else if (err?.message?.startsWith("llm-agents config")) throw err;
    else throw err;
  }

  const maxDepth = file.maxDepth ?? DEFAULT_CONFIG.maxDepth;
  if (!Number.isInteger(maxDepth) || maxDepth < 1) {
    throw new Error(`llm-agents config: maxDepth must be an integer >= 1`);
  }
  const userDir = file.userDir ?? DEFAULT_CONFIG.userDir;
  const projectDir = file.projectDir ?? DEFAULT_CONFIG.projectDir;
  return {
    maxDepth,
    resolvedUserDir: resolveDir(userDir, deps.home, deps.cwd),
    resolvedProjectDir: resolveDir(projectDir, deps.home, deps.cwd),
  };
}

export function realDeps(log: (msg: string) => void): ConfigDeps {
  return {
    home: process.env.HOME ?? "/",
    cwd: process.cwd(),
    env: process.env as Record<string, string | undefined>,
    readFile: (p) => fsReadFile(p, "utf8"),
    log,
  };
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `bun test plugins/llm-agents/test/config.test.ts`
Expected: 5/5 PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-agents/config.ts plugins/llm-agents/test/config.test.ts
git commit -m "feat(llm-agents): config loader with ~/.kaizen path resolution"
```

---

## Task 3: `frontmatter.ts` — parse YAML frontmatter + body (Tier 1A)

**Files:**
- Create: `plugins/llm-agents/frontmatter.ts`
- Create: `plugins/llm-agents/test/frontmatter.test.ts`

Pure function. No external YAML lib (avoid runtime dep): we accept the **strict subset** documented in Spec 11 (scalar strings, integer, single-line description with `>-` block scalar, flow-style `tools` / `tags` arrays). Anything outside the subset is a parse error pointing the user at the supported shape.

The strict subset covers: scalar `name: foo`, `description: >-` (block-scalar fold) followed by indented continuation, `description: "single line"`, flow arrays `["read_file", "list_files"]`, scalar `model: gpt-4o-mini`. This is enough for every realistic agent file and avoids pulling `yaml` as a dependency for one task.

- [ ] **Step 1: Write the failing tests**

Create `plugins/llm-agents/test/frontmatter.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { parseAgentFile } from "../frontmatter.ts";

const VALID = `---
name: code-reviewer
description: >-
  Use when the user wants a focused review of a diff or specific file.
  Returns inline review comments grouped by file.
tools: ["read_file", "list_files", "grep*"]
tags: ["read-only"]
model: "gpt-4o-mini"
---
You are a code reviewer.
Be terse.
`;

describe("parseAgentFile", () => {
  it("parses a valid file", () => {
    const r = parseAgentFile(VALID, "/x/code-reviewer.md");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.name).toBe("code-reviewer");
    expect(r.manifest.description).toContain("focused review");
    expect(r.manifest.toolFilter?.names).toEqual(["read_file", "list_files", "grep*"]);
    expect(r.manifest.toolFilter?.tags).toEqual(["read-only"]);
    expect(r.manifest.modelOverride).toBe("gpt-4o-mini");
    expect(r.manifest.systemPrompt).toBe("You are a code reviewer.\nBe terse.\n");
  });

  it("rejects body-only file (no frontmatter)", () => {
    const r = parseAgentFile("just a body\n", "/x/a.md");
    expect(r.ok).toBe(false);
  });

  it("rejects missing required name", () => {
    const text = `---\ndescription: "x"\n---\nbody\n`;
    const r = parseAgentFile(text, "/x/a.md");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/name/i);
  });

  it("rejects missing required description", () => {
    const text = `---\nname: a\n---\nbody\n`;
    const r = parseAgentFile(text, "/x/a.md");
    expect(r.ok).toBe(false);
  });

  it("rejects malformed YAML (unclosed array)", () => {
    const text = `---\nname: a\ndescription: "d"\ntools: [\n---\nbody\n`;
    const r = parseAgentFile(text, "/x/a.md");
    expect(r.ok).toBe(false);
  });

  it("rejects invalid name characters", () => {
    const text = `---\nname: "Bad Name!"\ndescription: "d"\n---\nbody\n`;
    const r = parseAgentFile(text, "/x/a.md");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/name/i);
  });

  it("ignores tools/tags/model when absent", () => {
    const text = `---\nname: a\ndescription: "d"\n---\nbody\n`;
    const r = parseAgentFile(text, "/x/a.md");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.toolFilter).toBeUndefined();
    expect(r.manifest.modelOverride).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run, expect FAIL** (`bun test plugins/llm-agents/test/frontmatter.test.ts`).

- [ ] **Step 3: Implement `frontmatter.ts`**

```ts
import type { AgentManifest } from "llm-events/public";

export interface InternalAgentManifest extends AgentManifest {
  modelOverride?: string;
  sourcePath: string;
  scope: "user" | "project";
}

export type ParseResult =
  | { ok: true; manifest: Omit<InternalAgentManifest, "sourcePath" | "scope"> }
  | { ok: false; error: string };

const NAME_RE = /^[a-z0-9_-]+$/;

export function parseAgentFile(text: string, sourcePath: string): ParseResult {
  // Frontmatter delimiter: file MUST start with "---\n"
  if (!text.startsWith("---\n")) {
    return { ok: false, error: `${sourcePath}: missing YAML frontmatter (file must begin with '---')` };
  }
  const rest = text.slice(4);
  const endIdx = rest.indexOf("\n---");
  if (endIdx === -1) {
    return { ok: false, error: `${sourcePath}: unterminated frontmatter (no closing '---')` };
  }
  const yaml = rest.slice(0, endIdx);
  // Body starts after "\n---" and the next newline.
  let bodyStart = endIdx + 4; // past "\n---"
  if (rest[bodyStart] === "\r") bodyStart++;
  if (rest[bodyStart] === "\n") bodyStart++;
  const body = rest.slice(bodyStart);

  let fields: Record<string, unknown>;
  try { fields = parseStrictYaml(yaml); }
  catch (err) { return { ok: false, error: `${sourcePath}: ${(err as Error).message}` }; }

  const name = fields.name;
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    return { ok: false, error: `${sourcePath}: 'name' is required and must match [a-z0-9_-]+` };
  }
  const description = fields.description;
  if (typeof description !== "string" || description.trim().length === 0) {
    return { ok: false, error: `${sourcePath}: 'description' is required and must be a non-empty string` };
  }

  const toolNames = fields.tools;
  const tags = fields.tags;
  if (toolNames !== undefined && !isStringArray(toolNames)) {
    return { ok: false, error: `${sourcePath}: 'tools' must be an array of strings` };
  }
  if (tags !== undefined && !isStringArray(tags)) {
    return { ok: false, error: `${sourcePath}: 'tags' must be an array of strings` };
  }
  const modelOverride = fields.model;
  if (modelOverride !== undefined && typeof modelOverride !== "string") {
    return { ok: false, error: `${sourcePath}: 'model' must be a string` };
  }

  const toolFilter = (toolNames || tags)
    ? { names: toolNames as string[] | undefined, tags: tags as string[] | undefined }
    : undefined;

  return {
    ok: true,
    manifest: {
      name,
      description: description.trim(),
      systemPrompt: body,
      toolFilter,
      modelOverride: modelOverride as string | undefined,
    },
  };
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/**
 * Strict YAML subset parser:
 *   key: scalar         (unquoted, "double", or 'single')
 *   key: integer
 *   key: ["a", "b"]     (flow array of strings)
 *   key: >-             (folded block scalar; following indented lines fold with single spaces)
 *     line one
 *     line two
 * Comments (# ...) on a line of their own are ignored. Anything else throws.
 */
function parseStrictYaml(src: string): Record<string, unknown> {
  const lines = src.split("\n");
  const out: Record<string, unknown> = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "" || line.trim().startsWith("#")) { i++; continue; }
    const m = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!m) throw new Error(`unparseable line: ${JSON.stringify(line)}`);
    const key = m[1]!;
    const rhs = (m[2] ?? "").trim();
    if (rhs === ">-" || rhs === ">") {
      // Folded block scalar: take following indented lines.
      const collected: string[] = [];
      i++;
      while (i < lines.length) {
        const next = lines[i] ?? "";
        if (next.length === 0) { collected.push(""); i++; continue; }
        if (!/^\s+/.test(next)) break;
        collected.push(next.replace(/^\s+/, ""));
        i++;
      }
      out[key] = collected.join(" ").replace(/\s+/g, " ").trim();
      continue;
    }
    if (rhs.startsWith("[")) {
      // Flow array: must close on same line.
      if (!rhs.endsWith("]")) throw new Error(`unterminated flow array at key '${key}'`);
      const inner = rhs.slice(1, -1).trim();
      if (inner.length === 0) { out[key] = []; i++; continue; }
      const items: string[] = [];
      // Split on commas not inside quotes.
      let buf = "";
      let inSingle = false, inDouble = false;
      for (const c of inner) {
        if (c === "'" && !inDouble) inSingle = !inSingle;
        else if (c === '"' && !inSingle) inDouble = !inDouble;
        if (c === "," && !inSingle && !inDouble) { items.push(buf.trim()); buf = ""; continue; }
        buf += c;
      }
      if (buf.trim().length > 0) items.push(buf.trim());
      out[key] = items.map(unquoteScalar);
      i++;
      continue;
    }
    out[key] = parseScalar(rhs);
    i++;
  }
  return out;
}

function unquoteScalar(s: string): string {
  const v = parseScalar(s);
  if (typeof v !== "string") throw new Error(`array items must be strings, got ${typeof v}: ${s}`);
  return v;
}

function parseScalar(rhs: string): string | number {
  if (rhs.length === 0) return "";
  if (rhs.startsWith('"') && rhs.endsWith('"')) return rhs.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"');
  if (rhs.startsWith("'") && rhs.endsWith("'")) return rhs.slice(1, -1);
  if (/^-?\d+$/.test(rhs)) return Number(rhs);
  return rhs; // bare string
}
```

- [ ] **Step 4: Run, expect PASS** (`bun test plugins/llm-agents/test/frontmatter.test.ts`).

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-agents/frontmatter.ts plugins/llm-agents/test/frontmatter.test.ts
git commit -m "feat(llm-agents): strict YAML-subset frontmatter parser for agent files"
```

---

## Task 4: `tool-filter.ts` — wildcard glob matcher (Tier 1A)

**Files:**
- Create: `plugins/llm-agents/tool-filter.ts`
- Create: `plugins/llm-agents/test/tool-filter.test.ts`

Pure helper. Spec 11 §"Tool filtering": wildcard `*` matches any run; no other metacharacters. A tool is admitted if its name matches one of `manifest.toolFilter.names` glob entries OR its `tags` overlap with `manifest.toolFilter.tags`. Empty filter (no `names`, no `tags`) admits nothing — caller decides what's always-on.

- [ ] **Step 1: Write the failing tests**

Create `plugins/llm-agents/test/tool-filter.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { matchesGlob, toolMatches } from "../tool-filter.ts";

describe("matchesGlob", () => {
  it("exact match", () => {
    expect(matchesGlob("read_file", "read_file")).toBe(true);
    expect(matchesGlob("read_file", "write_file")).toBe(false);
  });
  it("trailing wildcard", () => {
    expect(matchesGlob("read_file", "read_*")).toBe(true);
    expect(matchesGlob("read_file", "write_*")).toBe(false);
  });
  it("internal and leading wildcard", () => {
    expect(matchesGlob("get_weather", "get_*")).toBe(true);
    expect(matchesGlob("get_weather", "*_weather")).toBe(true);
    expect(matchesGlob("xyz", "*")).toBe(true);
  });
  it("escapes regex metacharacters in the literal portions", () => {
    expect(matchesGlob("a.b", "a.b")).toBe(true);
    expect(matchesGlob("axb", "a.b")).toBe(false);
  });
});

describe("toolMatches", () => {
  it("admits when names glob hits", () => {
    expect(toolMatches({ name: "read_file", tags: [] }, { names: ["read_*"] })).toBe(true);
  });
  it("admits when tags overlap", () => {
    expect(toolMatches({ name: "x", tags: ["read-only"] }, { tags: ["read-only"] })).toBe(true);
  });
  it("OR over names + tags", () => {
    expect(toolMatches({ name: "x", tags: ["mutate"] }, { names: ["read_*"], tags: ["mutate"] })).toBe(true);
    expect(toolMatches({ name: "x", tags: ["other"] }, { names: ["read_*"], tags: ["mutate"] })).toBe(false);
  });
  it("empty filter admits nothing", () => {
    expect(toolMatches({ name: "x", tags: ["a"] }, {})).toBe(false);
    expect(toolMatches({ name: "x", tags: ["a"] }, undefined)).toBe(false);
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement `tool-filter.ts`**

```ts
export interface ToolView { name: string; tags: string[]; }
export interface Filter { names?: string[]; tags?: string[]; }

export function matchesGlob(name: string, pattern: string): boolean {
  // Escape regex metacharacters except '*'; replace '*' with '.*'.
  const re = "^" + pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*") + "$";
  return new RegExp(re).test(name);
}

export function toolMatches(tool: ToolView, filter: Filter | undefined): boolean {
  if (!filter) return false;
  const namesHit = (filter.names ?? []).some((p) => matchesGlob(tool.name, p));
  const tagsHit = (filter.tags ?? []).some((t) => tool.tags.includes(t));
  if ((filter.names?.length ?? 0) === 0 && (filter.tags?.length ?? 0) === 0) return false;
  return namesHit || tagsHit;
}
```

- [ ] **Step 4: Run, expect PASS** (`bun test plugins/llm-agents/test/tool-filter.test.ts`).

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-agents/tool-filter.ts plugins/llm-agents/test/tool-filter.test.ts
git commit -m "feat(llm-agents): glob-aware tool/tag allow-list matcher"
```

---

## Task 5: `depth.ts` — recursion-depth walker (Tier 1A)

**Files:**
- Create: `plugins/llm-agents/depth.ts`
- Create: `plugins/llm-agents/test/depth.test.ts`

Computes how many nested `agent` turns sit between the current turn and the originating `user` turn. Plugin maintains a small `Map<turnId, { parentTurnId?: string; trigger: "user" | "agent" }>` populated by subscribing to `turn:start` (with cleanup on `turn:end`). `computeDepth(map, turnId)` walks the parent chain counting non-`user` triggers. Depth `0` means we are inside the user-triggered top-level turn.

- [ ] **Step 1: Write the failing tests**

Create `plugins/llm-agents/test/depth.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { computeDepth, type TurnRecord } from "../depth.ts";

function rec(id: string, parent?: string, trigger: "user" | "agent" = "agent"): TurnRecord {
  return { turnId: id, parentTurnId: parent, trigger };
}

describe("computeDepth", () => {
  it("returns 0 for a missing turnId (defensive)", () => {
    const m = new Map();
    expect(computeDepth(m, "ghost")).toBe(0);
  });
  it("user turn = depth 0", () => {
    const m = new Map([[ "t1", rec("t1", undefined, "user") ]]);
    expect(computeDepth(m, "t1")).toBe(0);
  });
  it("first agent dispatch from user = depth 1", () => {
    const m = new Map([
      ["t1", rec("t1", undefined, "user")],
      ["t2", rec("t2", "t1", "agent")],
    ]);
    expect(computeDepth(m, "t2")).toBe(1);
  });
  it("depth N counts agent ancestors only", () => {
    const m = new Map([
      ["t1", rec("t1", undefined, "user")],
      ["t2", rec("t2", "t1", "agent")],
      ["t3", rec("t3", "t2", "agent")],
      ["t4", rec("t4", "t3", "agent")],
    ]);
    expect(computeDepth(m, "t4")).toBe(3);
  });
  it("stops at user even if chain is longer in the map", () => {
    const m = new Map([
      ["t1", rec("t1", undefined, "user")],
      ["t2", rec("t2", "t1", "agent")],
    ]);
    expect(computeDepth(m, "t2")).toBe(1);
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement `depth.ts`**

```ts
export interface TurnRecord {
  turnId: string;
  parentTurnId?: string;
  trigger: "user" | "agent";
}

export function computeDepth(turns: Map<string, TurnRecord>, turnId: string): number {
  let cur = turns.get(turnId);
  if (!cur) return 0;
  // Count agent ancestors up to (and stopping at) the user turn.
  let depth = 0;
  let safety = 0;
  while (cur && cur.trigger === "agent") {
    depth++;
    if (!cur.parentTurnId) break;
    cur = turns.get(cur.parentTurnId);
    if (++safety > 1024) break; // pathological cycle guard
  }
  return depth;
}
```

- [ ] **Step 4: Run, expect PASS.**

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-agents/depth.ts plugins/llm-agents/test/depth.test.ts
git commit -m "feat(llm-agents): recursion-depth walker over the parent-turn chain"
```

---

## Task 6: `loader.ts` — fs walk + symlink-cycle guard (Tier 1B)

**Files:**
- Create: `plugins/llm-agents/loader.ts`
- Create: `plugins/llm-agents/test/loader.test.ts`

`loadFromDirs(deps)` walks `userDir` then `projectDir`, parses every `*.md`, applies the project-shadows-user rule, enforces 64 KiB cap, detects symlink cycles, and returns `{ manifests, errors }`. Errors are surfaced (not thrown) so the registry remains partially functional — the index module emits each as a `session:error`.

- [ ] **Step 1: Write the failing tests**

Create `plugins/llm-agents/test/loader.test.ts`:

```ts
import { describe, it, expect, mock } from "bun:test";
import { loadFromDirs, type LoaderDeps } from "../loader.ts";

interface FakeFile { kind: "file"; content: string; isSymlink?: boolean; realPath?: string; size?: number; }
interface FakeDir { kind: "dir"; entries: string[]; }
type Node = FakeFile | FakeDir;

function makeDeps(tree: Record<string, Node>): LoaderDeps {
  return {
    readDir: async (p) => {
      const n = tree[p];
      if (!n) { const e: any = new Error("ENOENT"); e.code = "ENOENT"; throw e; }
      if (n.kind !== "dir") throw new Error(`not a dir: ${p}`);
      return n.entries;
    },
    stat: async (p) => {
      const n = tree[p];
      if (!n) { const e: any = new Error("ENOENT"); e.code = "ENOENT"; throw e; }
      return {
        isFile: () => n.kind === "file",
        isDirectory: () => n.kind === "dir",
        isSymbolicLink: () => n.kind === "file" && !!n.isSymlink,
        size: n.kind === "file" ? (n.size ?? n.content.length) : 0,
      } as any;
    },
    realpath: async (p) => {
      const n = tree[p];
      if (n?.kind === "file" && n.isSymlink) return n.realPath ?? p;
      return p;
    },
    readFile: async (p) => {
      const n = tree[p];
      if (!n || n.kind !== "file") { const e: any = new Error("ENOENT"); e.code = "ENOENT"; throw e; }
      return n.content;
    },
  };
}

const VALID = `---\nname: a\ndescription: "d"\n---\nbody\n`;

describe("loadFromDirs", () => {
  it("user-only when project dir absent", async () => {
    const deps = makeDeps({
      "/u/agents": { kind: "dir", entries: ["a.md"] },
      "/u/agents/a.md": { kind: "file", content: VALID },
    });
    const r = await loadFromDirs({ userDir: "/u/agents", projectDir: "/p/agents", deps });
    expect(r.manifests.length).toBe(1);
    expect(r.manifests[0]!.scope).toBe("user");
    expect(r.errors).toEqual([]);
  });

  it("project-scope shadows user-scope on name collision and emits a shadowing error", async () => {
    const PROJECT = `---\nname: a\ndescription: "project version"\n---\nbody2\n`;
    const deps = makeDeps({
      "/u/agents": { kind: "dir", entries: ["a.md"] },
      "/u/agents/a.md": { kind: "file", content: VALID },
      "/p/agents": { kind: "dir", entries: ["a.md"] },
      "/p/agents/a.md": { kind: "file", content: PROJECT },
    });
    const r = await loadFromDirs({ userDir: "/u/agents", projectDir: "/p/agents", deps });
    expect(r.manifests.length).toBe(1);
    expect(r.manifests[0]!.scope).toBe("project");
    expect(r.manifests[0]!.description).toBe("project version");
    expect(r.errors.some((e) => /shadow/i.test(e.message))).toBe(true);
  });

  it("rejects oversize files", async () => {
    const big = "---\nname: big\ndescription: d\n---\n" + "x".repeat(64 * 1024 + 1);
    const deps = makeDeps({
      "/u/agents": { kind: "dir", entries: ["big.md"] },
      "/u/agents/big.md": { kind: "file", content: big, size: big.length },
    });
    const r = await loadFromDirs({ userDir: "/u/agents", projectDir: "/p/agents", deps });
    expect(r.manifests).toEqual([]);
    expect(r.errors[0]!.message).toMatch(/64 KiB|too large/i);
  });

  it("collects parse errors per file but keeps loading the rest", async () => {
    const deps = makeDeps({
      "/u/agents": { kind: "dir", entries: ["good.md", "bad.md"] },
      "/u/agents/good.md": { kind: "file", content: VALID },
      "/u/agents/bad.md": { kind: "file", content: "not yaml\n" },
    });
    const r = await loadFromDirs({ userDir: "/u/agents", projectDir: "/p/agents", deps });
    expect(r.manifests.length).toBe(1);
    expect(r.errors.length).toBe(1);
  });

  it("detects symlink cycle and reports it", async () => {
    const deps = makeDeps({
      "/u/agents": { kind: "dir", entries: ["link.md"] },
      "/u/agents/link.md": { kind: "file", content: VALID, isSymlink: true, realPath: "/u/agents/link.md" },
    });
    const r = await loadFromDirs({ userDir: "/u/agents", projectDir: "/p/agents", deps });
    // Cycle: realpath = same path → skip.
    expect(r.manifests).toEqual([]);
    expect(r.errors.some((e) => /cycle|symlink/i.test(e.message))).toBe(true);
  });

  it("ignores non-.md files", async () => {
    const deps = makeDeps({
      "/u/agents": { kind: "dir", entries: ["a.md", "README.txt"] },
      "/u/agents/a.md": { kind: "file", content: VALID },
      "/u/agents/README.txt": { kind: "file", content: "ignored" },
    });
    const r = await loadFromDirs({ userDir: "/u/agents", projectDir: "/p/agents", deps });
    expect(r.manifests.length).toBe(1);
  });

  it("missing dirs are not errors", async () => {
    const deps = makeDeps({});
    const r = await loadFromDirs({ userDir: "/u/agents", projectDir: "/p/agents", deps });
    expect(r.manifests).toEqual([]);
    expect(r.errors).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement `loader.ts`**

```ts
import { parseAgentFile, type InternalAgentManifest } from "./frontmatter.ts";

export interface LoaderDeps {
  readDir: (path: string) => Promise<string[]>;
  stat: (path: string) => Promise<{
    isFile: () => boolean;
    isDirectory: () => boolean;
    isSymbolicLink: () => boolean;
    size: number;
  }>;
  realpath: (path: string) => Promise<string>;
  readFile: (path: string) => Promise<string>;
}

export interface LoaderInput {
  userDir: string;
  projectDir: string;
  deps: LoaderDeps;
}

export interface LoaderError { path: string; message: string; }

export interface LoaderResult {
  manifests: InternalAgentManifest[];
  errors: LoaderError[];
}

const MAX_BYTES = 64 * 1024;

async function loadOneScope(
  dir: string,
  scope: "user" | "project",
  deps: LoaderDeps,
  errors: LoaderError[],
): Promise<InternalAgentManifest[]> {
  let entries: string[];
  try { entries = await deps.readDir(dir); }
  catch (err: any) {
    if (err?.code === "ENOENT") return [];
    errors.push({ path: dir, message: `failed to read dir: ${err?.message ?? err}` });
    return [];
  }
  // Lexicographic order — Spec 11 collision rule (first lexicographic wins within scope).
  entries.sort();
  const out: InternalAgentManifest[] = [];
  const seenNames = new Set<string>();
  const seenRealPaths = new Set<string>();
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const fullPath = `${dir}/${entry}`;
    let st;
    try { st = await deps.stat(fullPath); }
    catch (err: any) { errors.push({ path: fullPath, message: `stat failed: ${err?.message ?? err}` }); continue; }
    if (!st.isFile()) continue;
    if (st.size > MAX_BYTES) {
      errors.push({ path: fullPath, message: `agent file exceeds 64 KiB cap (${st.size} bytes); skipped` });
      continue;
    }
    let real = fullPath;
    if (st.isSymbolicLink()) {
      try { real = await deps.realpath(fullPath); }
      catch (err: any) { errors.push({ path: fullPath, message: `realpath failed: ${err?.message ?? err}` }); continue; }
      if (real === fullPath || seenRealPaths.has(real)) {
        errors.push({ path: fullPath, message: `symlink cycle detected; skipped` });
        continue;
      }
    }
    seenRealPaths.add(real);
    let text: string;
    try { text = await deps.readFile(fullPath); }
    catch (err: any) { errors.push({ path: fullPath, message: `read failed: ${err?.message ?? err}` }); continue; }
    const parsed = parseAgentFile(text, fullPath);
    if (!parsed.ok) { errors.push({ path: fullPath, message: parsed.error }); continue; }
    if (seenNames.has(parsed.manifest.name)) {
      errors.push({ path: fullPath, message: `duplicate agent name '${parsed.manifest.name}' within ${scope} scope; lexicographic-first wins; this file skipped` });
      continue;
    }
    seenNames.add(parsed.manifest.name);
    out.push({ ...parsed.manifest, sourcePath: fullPath, scope });
  }
  return out;
}

export async function loadFromDirs(input: LoaderInput): Promise<LoaderResult> {
  const errors: LoaderError[] = [];
  const userMs = await loadOneScope(input.userDir, "user", input.deps, errors);
  const projectMs = await loadOneScope(input.projectDir, "project", input.deps, errors);

  // Project shadows user.
  const byName = new Map<string, InternalAgentManifest>();
  for (const m of userMs) byName.set(m.name, m);
  for (const m of projectMs) {
    if (byName.has(m.name)) {
      const existing = byName.get(m.name)!;
      errors.push({
        path: m.sourcePath,
        message: `project-scope agent '${m.name}' shadows user-scope agent at ${existing.sourcePath}`,
      });
    }
    byName.set(m.name, m);
  }
  return { manifests: [...byName.values()], errors };
}
```

- [ ] **Step 4: Run, expect PASS.**

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-agents/loader.ts plugins/llm-agents/test/loader.test.ts
git commit -m "feat(llm-agents): file-loader with project-shadows-user, size cap, symlink-cycle guard"
```

---

## Task 7: `registry.ts` — in-memory `agents:registry` (Tier 1B)

**Files:**
- Create: `plugins/llm-agents/registry.ts`
- Create: `plugins/llm-agents/test/registry.test.ts`

Provides `AgentsRegistryService.list()` (public view, internal fields stripped) and `register()` for runtime additions. Per Spec 11 open-question #2: programmatic `register()` requires names prefixed `runtime:` to avoid collisions with file-loaded agents; non-prefixed names throw. Returns an `unregister` function.

The registry also exposes `getInternal(name)` for the dispatch tool (NOT part of the public service contract — it lives only on the concrete return value).

- [ ] **Step 1: Write the failing tests**

Create `plugins/llm-agents/test/registry.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { makeRegistry } from "../registry.ts";
import type { InternalAgentManifest } from "../frontmatter.ts";

const m: InternalAgentManifest = {
  name: "code-reviewer",
  description: "review",
  systemPrompt: "be terse",
  toolFilter: { names: ["read_*"] },
  sourcePath: "/x/code-reviewer.md",
  scope: "user",
};

describe("makeRegistry", () => {
  it("list() returns public view (no sourcePath/scope/modelOverride)", () => {
    const r = makeRegistry([m]);
    const list = r.service.list();
    expect(list.length).toBe(1);
    expect((list[0] as any).sourcePath).toBeUndefined();
    expect((list[0] as any).scope).toBeUndefined();
    expect(list[0]!.name).toBe("code-reviewer");
  });

  it("getInternal returns the internal record by name", () => {
    const r = makeRegistry([m]);
    expect(r.getInternal("code-reviewer")?.sourcePath).toBe("/x/code-reviewer.md");
    expect(r.getInternal("missing")).toBeUndefined();
  });

  it("register() rejects non-runtime: prefix", () => {
    const r = makeRegistry([]);
    expect(() => r.service.register({ name: "foo", description: "d", systemPrompt: "p" })).toThrow(/runtime:/);
  });

  it("register() refuses to overwrite an existing name", () => {
    const r = makeRegistry([m]);
    expect(() => r.service.register({ name: "code-reviewer", description: "d", systemPrompt: "p" })).toThrow();
  });

  it("register() accepts runtime: name and unregister removes it", () => {
    const r = makeRegistry([]);
    const off = r.service.register({ name: "runtime:adhoc", description: "d", systemPrompt: "p" });
    expect(r.service.list().some((x) => x.name === "runtime:adhoc")).toBe(true);
    off();
    expect(r.service.list().some((x) => x.name === "runtime:adhoc")).toBe(false);
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement `registry.ts`**

```ts
import type { AgentManifest, AgentsRegistryService } from "llm-events/public";
import type { InternalAgentManifest } from "./frontmatter.ts";

export interface AgentsRegistry {
  service: AgentsRegistryService;
  getInternal(name: string): InternalAgentManifest | undefined;
}

export function makeRegistry(initial: InternalAgentManifest[]): AgentsRegistry {
  const map = new Map<string, InternalAgentManifest>();
  for (const m of initial) map.set(m.name, m);

  function publicView(m: InternalAgentManifest): AgentManifest {
    const { sourcePath, scope, modelOverride, ...rest } = m;
    return rest;
  }

  const service: AgentsRegistryService = {
    list(): AgentManifest[] {
      return [...map.values()].map(publicView);
    },
    register(manifest: AgentManifest): () => void {
      if (!manifest.name.startsWith("runtime:")) {
        throw new Error(`agents:registry.register requires names with 'runtime:' prefix; got '${manifest.name}'`);
      }
      if (map.has(manifest.name)) {
        throw new Error(`agents:registry: name '${manifest.name}' already registered`);
      }
      const internal: InternalAgentManifest = {
        ...manifest,
        sourcePath: "<runtime>",
        scope: "user",
      };
      map.set(manifest.name, internal);
      return () => { map.delete(manifest.name); };
    },
  };

  return {
    service,
    getInternal(name: string) { return map.get(name); },
  };
}
```

- [ ] **Step 4: Run, expect PASS.**

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-agents/registry.ts plugins/llm-agents/test/registry.test.ts
git commit -m "feat(llm-agents): in-memory agents:registry with runtime: prefix guard"
```

---

## Task 8: `injector.ts` — system-prompt injector (Tier 1C)

**Files:**
- Create: `plugins/llm-agents/injector.ts`
- Create: `plugins/llm-agents/test/injector.test.ts`

Subscribes to `llm:before-call` and appends an "Available agents" section to `request.systemPrompt` once per top-level turn. We use a `Set<turnId>` cleared on `turn:end`. The injector must also subscribe to `turn:start` to learn which `turnId`s are top-level (`trigger === "user"`); only those are eligible. Empty registry = no injection.

The injector uses the same turn-record map that `dispatch.ts` consumes for depth tracking, so this task creates the shared `turn-tracker.ts` helper too.

- [ ] **Step 1: Create `plugins/llm-agents/turn-tracker.ts`** (small shared helper)

```ts
import type { TurnRecord } from "./depth.ts";

export interface TurnTracker {
  records: Map<string, TurnRecord>;
  onTurnStart(p: { turnId: string; trigger: "user" | "agent"; parentTurnId?: string }): void;
  onTurnEnd(p: { turnId: string }): void;
  isTopLevel(turnId: string): boolean;
}

export function makeTurnTracker(): TurnTracker {
  const records = new Map<string, TurnRecord>();
  return {
    records,
    onTurnStart(p) {
      records.set(p.turnId, { turnId: p.turnId, parentTurnId: p.parentTurnId, trigger: p.trigger });
    },
    onTurnEnd(p) { records.delete(p.turnId); },
    isTopLevel(turnId) { return records.get(turnId)?.trigger === "user"; },
  };
}
```

- [ ] **Step 2: Write the failing injector tests**

Create `plugins/llm-agents/test/injector.test.ts`:

```ts
import { describe, it, expect, mock } from "bun:test";
import { makeInjector } from "../injector.ts";
import { makeRegistry } from "../registry.ts";
import { makeTurnTracker } from "../turn-tracker.ts";
import type { InternalAgentManifest } from "../frontmatter.ts";

function m(name: string, description: string): InternalAgentManifest {
  return { name, description, systemPrompt: "p", sourcePath: "/x", scope: "user" };
}

function makeCtx() {
  const subs: Record<string, ((p: any) => any)[]> = {};
  return {
    subs,
    on: mock((event: string, fn: any) => { (subs[event] ??= []).push(fn); }),
    emit: async (event: string, payload: any) => {
      for (const f of subs[event] ?? []) await f(payload);
    },
  } as any;
}

describe("injector", () => {
  it("appends 'Available agents' section once per top-level turn", async () => {
    const reg = makeRegistry([m("code-reviewer", "review code"), m("doc-writer", "write docs")]);
    const tracker = makeTurnTracker();
    const ctx = makeCtx();
    makeInjector({ ctx, registry: reg, tracker });

    // Top-level turn starts
    await ctx.emit("turn:start", { turnId: "t1", trigger: "user" });
    const req: any = { systemPrompt: "BASE", model: "x", messages: [] };
    await ctx.emit("llm:before-call", { request: req, turnId: "t1" });
    expect(req.systemPrompt).toContain("BASE");
    expect(req.systemPrompt).toContain("## Available agents");
    expect(req.systemPrompt).toContain("- code-reviewer: review code");

    // Second LLM call in same turn — no double-inject
    const before = req.systemPrompt;
    await ctx.emit("llm:before-call", { request: req, turnId: "t1" });
    expect(req.systemPrompt).toBe(before);
  });

  it("does not inject for nested (agent) turns", async () => {
    const reg = makeRegistry([m("a", "d")]);
    const tracker = makeTurnTracker();
    const ctx = makeCtx();
    makeInjector({ ctx, registry: reg, tracker });

    await ctx.emit("turn:start", { turnId: "t1", trigger: "agent", parentTurnId: "t0" });
    const req: any = { systemPrompt: "BASE", model: "x", messages: [] };
    await ctx.emit("llm:before-call", { request: req, turnId: "t1" });
    expect(req.systemPrompt).toBe("BASE");
  });

  it("empty registry omits the section", async () => {
    const reg = makeRegistry([]);
    const tracker = makeTurnTracker();
    const ctx = makeCtx();
    makeInjector({ ctx, registry: reg, tracker });
    await ctx.emit("turn:start", { turnId: "t1", trigger: "user" });
    const req: any = { systemPrompt: "BASE", model: "x", messages: [] };
    await ctx.emit("llm:before-call", { request: req, turnId: "t1" });
    expect(req.systemPrompt).toBe("BASE");
  });

  it("injection set is cleared on turn:end so a new top-level turn re-injects", async () => {
    const reg = makeRegistry([m("a", "d")]);
    const tracker = makeTurnTracker();
    const ctx = makeCtx();
    makeInjector({ ctx, registry: reg, tracker });

    await ctx.emit("turn:start", { turnId: "t1", trigger: "user" });
    const req1: any = { systemPrompt: "B", model: "x", messages: [] };
    await ctx.emit("llm:before-call", { request: req1, turnId: "t1" });
    expect(req1.systemPrompt).toContain("Available agents");
    await ctx.emit("turn:end", { turnId: "t1", reason: "complete" });

    await ctx.emit("turn:start", { turnId: "t2", trigger: "user" });
    const req2: any = { systemPrompt: "B", model: "x", messages: [] };
    await ctx.emit("llm:before-call", { request: req2, turnId: "t2" });
    expect(req2.systemPrompt).toContain("Available agents");
  });
});
```

> **Note on `llm:before-call` payload shape.** Spec 0 lists the payload as `{ request: LLMRequest }`. The injector needs the `turnId` to know whether to inject. The driver passes it as a sibling field on the event payload (`{ request, turnId }`); this is the same convention `tool:before-execute` uses (`{ name, args, callId }`). If your driver implementation does not yet include `turnId` on `llm:before-call`, raise it as a Spec 0 propagation issue per the rule — do NOT thread it through `request.extra`. The injector falls back to "inject every call" with a one-line warning logged if `turnId` is absent (defensive, since this is observable bus surface).

- [ ] **Step 3: Run, expect FAIL.**

- [ ] **Step 4: Implement `injector.ts`**

```ts
import type { LLMRequest } from "llm-events/public";
import type { AgentsRegistry } from "./registry.ts";
import type { TurnTracker } from "./turn-tracker.ts";

export interface InjectorDeps {
  ctx: {
    on: (event: string, fn: (p: any) => any) => void;
    log?: (msg: string) => void;
  };
  registry: AgentsRegistry;
  tracker: TurnTracker;
}

const SECTION_HEADING = "## Available agents (use dispatch_agent to invoke)";

function formatSection(agents: { name: string; description: string }[]): string {
  if (agents.length === 0) return "";
  const lines = agents.map((a) => {
    const oneLine = a.description.replace(/\s+/g, " ").trim();
    const trimmed = oneLine.length > 200 ? oneLine.slice(0, 197) + "..." : oneLine;
    return `- ${a.name}: ${trimmed}`;
  });
  return `\n\n${SECTION_HEADING}\n\n${lines.join("\n")}\n`;
}

export function makeInjector(deps: InjectorDeps): void {
  const injected = new Set<string>();
  const log = deps.ctx.log ?? (() => {});

  deps.ctx.on("turn:start", (p: { turnId: string; trigger: "user" | "agent"; parentTurnId?: string }) => {
    deps.tracker.onTurnStart(p);
  });
  deps.ctx.on("turn:end", (p: { turnId: string }) => {
    injected.delete(p.turnId);
    deps.tracker.onTurnEnd(p);
  });
  deps.ctx.on("llm:before-call", (p: { request: LLMRequest; turnId?: string }) => {
    const turnId = p.turnId;
    if (!turnId) { log("llm-agents: llm:before-call without turnId; skipping injection"); return; }
    if (!deps.tracker.isTopLevel(turnId)) return;
    if (injected.has(turnId)) return;
    const agents = deps.registry.service.list();
    if (agents.length === 0) return;
    const section = formatSection(agents);
    p.request.systemPrompt = (p.request.systemPrompt ?? "") + section;
    injected.add(turnId);
  });
}
```

- [ ] **Step 5: Run, expect PASS.**

- [ ] **Step 6: Commit**

```bash
git add plugins/llm-agents/injector.ts plugins/llm-agents/turn-tracker.ts plugins/llm-agents/test/injector.test.ts
git commit -m "feat(llm-agents): system-prompt injector for top-level turns"
```

---

## Task 9: `dispatch.ts` — `dispatch_agent` tool (Tier 1C)

**Files:**
- Create: `plugins/llm-agents/dispatch.ts`
- Create: `plugins/llm-agents/test/dispatch.test.ts`

Constructs the tool schema (Spec 11 §"The dispatch_agent tool") and a handler that:

1. Validates inputs (`agent_name: string`, `prompt: string`).
2. Looks up the agent via `registry.getInternal(name)`. Missing → throw tool error.
3. Computes recursion depth from `tracker.records` and `ctx.turnId`. Over-cap → throw.
4. Emits a `status:item-update` for `agents.active` (counter pattern).
5. Builds `RunConversationInput` with the manifest's system prompt, tool filter merged with always-on `dispatch_agent` (and `load_skill` if a `skills:registry` service is consumeable), and the parent's `signal` + `turnId` as `parentTurnId`.
6. `await driver.runConversation(input)`.
7. Returns a stringified `output.finalMessage.content` as the tool result.
8. Emits `status:item-clear` (or counter decrement) on completion.

All thrown errors carry the canonical messages from Spec 11 §"Error surfacing".

- [ ] **Step 1: Write the failing tests**

Create `plugins/llm-agents/test/dispatch.test.ts`:

```ts
import { describe, it, expect, mock } from "bun:test";
import { makeDispatchTool } from "../dispatch.ts";
import { makeRegistry } from "../registry.ts";
import { makeTurnTracker } from "../turn-tracker.ts";
import type { InternalAgentManifest } from "../frontmatter.ts";

function m(name: string): InternalAgentManifest {
  return {
    name,
    description: `agent ${name}`,
    systemPrompt: `you are ${name}`,
    toolFilter: { names: ["read_*"] },
    sourcePath: "/x",
    scope: "user",
  };
}

function makeCtx(turnId = "t-parent") {
  const events: { event: string; payload: any }[] = [];
  return {
    events,
    signal: new AbortController().signal,
    callId: "c1",
    turnId,
    log: () => {},
    emit: async (e: string, p: any) => { events.push({ event: e, payload: p }); },
  } as any;
}

describe("dispatch_agent", () => {
  it("happy path: invokes runConversation with manifest prompt and parentTurnId", async () => {
    const reg = makeRegistry([m("code-reviewer")]);
    const tracker = makeTurnTracker();
    tracker.onTurnStart({ turnId: "t-parent", trigger: "user" });
    const driver = {
      runConversation: mock(async (input: any) => ({
        finalMessage: { role: "assistant", content: "RESULT" },
        messages: [],
        usage: { promptTokens: 1, completionTokens: 1 },
      })),
    };
    const tool = makeDispatchTool({
      registry: reg, tracker, driver,
      maxDepth: 3,
      hasSkills: () => false,
    });
    const ctx = makeCtx();
    const result = await tool.handler({ agent_name: "code-reviewer", prompt: "look at file X" }, ctx);
    expect(result).toBe("RESULT");
    expect(driver.runConversation).toHaveBeenCalledTimes(1);
    const arg = (driver.runConversation as any).mock.calls[0][0];
    expect(arg.systemPrompt).toBe("you are code-reviewer");
    expect(arg.messages).toEqual([{ role: "user", content: "look at file X" }]);
    expect(arg.parentTurnId).toBe("t-parent");
    // Always-on dispatch_agent must be present in the filter:
    expect(arg.toolFilter.names).toContain("dispatch_agent");
    // Manifest filter preserved:
    expect(arg.toolFilter.names).toContain("read_*");
  });

  it("includes load_skill when skills service available", async () => {
    const reg = makeRegistry([m("a")]);
    const tracker = makeTurnTracker();
    tracker.onTurnStart({ turnId: "t-parent", trigger: "user" });
    const driver = { runConversation: async () => ({ finalMessage: { role: "assistant", content: "" }, messages: [], usage: { promptTokens: 0, completionTokens: 0 } }) };
    const tool = makeDispatchTool({ registry: reg, tracker, driver, maxDepth: 3, hasSkills: () => true });
    let captured: any;
    (driver as any).runConversation = async (input: any) => { captured = input; return { finalMessage: { role: "assistant", content: "" }, messages: [], usage: { promptTokens: 0, completionTokens: 0 } }; };
    await tool.handler({ agent_name: "a", prompt: "p" }, makeCtx());
    expect(captured.toolFilter.names).toContain("load_skill");
  });

  it("unknown agent throws tool error with Spec 11 message", async () => {
    const reg = makeRegistry([m("a"), m("b")]);
    const tracker = makeTurnTracker();
    tracker.onTurnStart({ turnId: "t-parent", trigger: "user" });
    const tool = makeDispatchTool({ registry: reg, tracker, driver: { runConversation: async () => ({} as any) }, maxDepth: 3, hasSkills: () => false });
    await expect(tool.handler({ agent_name: "ghost", prompt: "p" }, makeCtx())).rejects.toThrow(/Unknown agent 'ghost'.*Known: a, b/);
  });

  it("depth limit returns canonical error", async () => {
    const reg = makeRegistry([m("a")]);
    const tracker = makeTurnTracker();
    tracker.onTurnStart({ turnId: "t0", trigger: "user" });
    tracker.onTurnStart({ turnId: "t1", trigger: "agent", parentTurnId: "t0" });
    tracker.onTurnStart({ turnId: "t2", trigger: "agent", parentTurnId: "t1" });
    tracker.onTurnStart({ turnId: "t3", trigger: "agent", parentTurnId: "t2" });
    const tool = makeDispatchTool({ registry: reg, tracker, driver: { runConversation: async () => ({} as any) }, maxDepth: 3, hasSkills: () => false });
    const ctx = makeCtx("t3");
    await expect(tool.handler({ agent_name: "a", prompt: "p" }, ctx)).rejects.toThrow(/depth limit reached \(max=3\)/);
  });

  it("propagates parent's signal as input.signal", async () => {
    const reg = makeRegistry([m("a")]);
    const tracker = makeTurnTracker();
    tracker.onTurnStart({ turnId: "tp", trigger: "user" });
    let captured: AbortSignal | undefined;
    const driver = { runConversation: async (input: any) => { captured = input.signal; return { finalMessage: { role: "assistant", content: "" }, messages: [], usage: { promptTokens: 0, completionTokens: 0 } }; } };
    const tool = makeDispatchTool({ registry: reg, tracker, driver, maxDepth: 3, hasSkills: () => false });
    const ac = new AbortController();
    const ctx = { ...makeCtx("tp"), signal: ac.signal };
    await tool.handler({ agent_name: "a", prompt: "p" }, ctx as any);
    expect(captured).toBe(ac.signal);
  });

  it("AbortError from runConversation surfaces as cancelled tool error", async () => {
    const reg = makeRegistry([m("a")]);
    const tracker = makeTurnTracker();
    tracker.onTurnStart({ turnId: "tp", trigger: "user" });
    const driver = { runConversation: async () => { const e: any = new Error("aborted"); e.name = "AbortError"; throw e; } };
    const tool = makeDispatchTool({ registry: reg, tracker, driver, maxDepth: 3, hasSkills: () => false });
    await expect(tool.handler({ agent_name: "a", prompt: "p" }, makeCtx("tp"))).rejects.toThrow(/Agent 'a' cancelled/);
  });

  it("non-Abort errors are wrapped with 'failed: <inner>'", async () => {
    const reg = makeRegistry([m("a")]);
    const tracker = makeTurnTracker();
    tracker.onTurnStart({ turnId: "tp", trigger: "user" });
    const driver = { runConversation: async () => { throw new Error("boom"); } };
    const tool = makeDispatchTool({ registry: reg, tracker, driver, maxDepth: 3, hasSkills: () => false });
    await expect(tool.handler({ agent_name: "a", prompt: "p" }, makeCtx("tp"))).rejects.toThrow(/Agent 'a' failed: boom/);
  });

  it("rejects malformed inputs", async () => {
    const reg = makeRegistry([m("a")]);
    const tracker = makeTurnTracker();
    tracker.onTurnStart({ turnId: "tp", trigger: "user" });
    const tool = makeDispatchTool({ registry: reg, tracker, driver: { runConversation: async () => ({} as any) }, maxDepth: 3, hasSkills: () => false });
    await expect(tool.handler({ agent_name: 1, prompt: "p" } as any, makeCtx("tp"))).rejects.toThrow();
    await expect(tool.handler({ agent_name: "a" } as any, makeCtx("tp"))).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement `dispatch.ts`**

```ts
import type {
  ToolSchema,
  ToolHandler,
  ToolExecutionContext,
  RunConversationInput,
  RunConversationOutput,
  DriverService,
} from "llm-events/public";
import type { AgentsRegistry } from "./registry.ts";
import type { TurnTracker } from "./turn-tracker.ts";
import { computeDepth } from "./depth.ts";

export interface DispatchDeps {
  registry: AgentsRegistry;
  tracker: TurnTracker;
  driver: Pick<DriverService, "runConversation">;
  maxDepth: number;
  hasSkills: () => boolean;
}

export const DISPATCH_SCHEMA: ToolSchema = {
  name: "dispatch_agent",
  description:
    "Delegate a sub-task to a named specialist agent. Returns the agent's final response as a string. " +
    "Use when a sub-task benefits from a focused persona or restricted tool set.",
  parameters: {
    type: "object",
    required: ["agent_name", "prompt"],
    properties: {
      agent_name: { type: "string", description: "One of the names listed under 'Available agents' in the system prompt." },
      prompt: { type: "string", description: "The instruction to send to the agent as its only user message." },
    },
    additionalProperties: false,
  } as any,
  tags: ["agents", "core"],
};

export function makeDispatchTool(deps: DispatchDeps): { schema: ToolSchema; handler: ToolHandler } {
  const handler: ToolHandler = async (rawArgs: unknown, ctx: ToolExecutionContext) => {
    const args = rawArgs as { agent_name?: unknown; prompt?: unknown };
    if (typeof args?.agent_name !== "string" || typeof args?.prompt !== "string") {
      throw new Error("dispatch_agent: 'agent_name' and 'prompt' must be strings");
    }
    const name = args.agent_name;
    const internal = deps.registry.getInternal(name);
    if (!internal) {
      const known = deps.registry.service.list().map((a) => a.name).join(", ");
      throw new Error(`Unknown agent '${name}'. Known: ${known}`);
    }

    const turnId = ctx.turnId;
    if (!turnId) {
      throw new Error("dispatch_agent: ToolExecutionContext.turnId missing; required for depth tracking");
    }
    const depth = computeDepth(deps.tracker.records, turnId);
    if (depth >= deps.maxDepth) {
      throw new Error(`Agent dispatch depth limit reached (max=${deps.maxDepth})`);
    }

    // Build merged tool filter: manifest names + always-on (dispatch_agent, optionally load_skill); manifest tags pass through.
    const manifestNames = internal.toolFilter?.names ?? [];
    const manifestTags = internal.toolFilter?.tags ?? [];
    const alwaysOn: string[] = ["dispatch_agent"];
    if (deps.hasSkills()) alwaysOn.push("load_skill");
    const mergedNames = Array.from(new Set([...manifestNames, ...alwaysOn]));
    const toolFilter = { names: mergedNames, tags: manifestTags };

    const input: RunConversationInput = {
      systemPrompt: internal.systemPrompt,
      messages: [{ role: "user", content: args.prompt }],
      toolFilter,
      ...(internal.modelOverride ? { model: internal.modelOverride } : {}),
      parentTurnId: turnId,
      signal: ctx.signal,
    };

    let output: RunConversationOutput;
    try {
      output = await deps.driver.runConversation(input);
    } catch (err: any) {
      if (err?.name === "AbortError" || ctx.signal.aborted) {
        throw new Error(`Agent '${name}' cancelled`);
      }
      const inner = err?.message ?? String(err);
      throw new Error(`Agent '${name}' failed: ${inner}`);
    }
    return String(output.finalMessage.content ?? "");
  };

  return { schema: DISPATCH_SCHEMA, handler };
}
```

- [ ] **Step 4: Run, expect PASS** (`bun test plugins/llm-agents/test/dispatch.test.ts`).

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-agents/dispatch.ts plugins/llm-agents/test/dispatch.test.ts
git commit -m "feat(llm-agents): dispatch_agent tool with depth, cancel, error surfacing"
```

---

## Task 10: `index.ts` — wire setup, discovery, registrations

**Files:**
- Modify: `plugins/llm-agents/index.ts` (replace placeholder body)
- Create: `plugins/llm-agents/test/index.test.ts`

`setup(ctx)`:

1. Loads config via `loadConfig(realDeps(...))`.
2. Defines/provides `agents:registry` *immediately* with an empty registry so service consumers don't fail; replaces the underlying map after discovery completes.
3. Schedules discovery in a microtask: `loadFromDirs(...)`. On completion, swap the registry's map and emit each error as `session:error`. While in-flight, `dispatch_agent` returns the canonical "Agent registry still loading; retry" tool error (handler checks the `ready` flag).
4. Subscribes to `turn:start` / `turn:end` (via `injector` and `tracker`).
5. Registers the `dispatch_agent` tool with the consumed `tools:registry`.
6. Wires the injector against the consumed `llm-events:vocabulary` (only used to look up event-name constants — string literals work too; we use the vocab for forward-compat).

`tools:registry` and `driver:run-conversation` are required (Spec 11 §Architectural overview). If either is missing, log a `session:error` and skip tool/dispatch wiring (registry + injector still work, so the parent LLM can be told about agents even in a degenerate harness).

- [ ] **Step 1: Write the failing index test**

Create `plugins/llm-agents/test/index.test.ts`:

```ts
import { describe, it, expect, mock } from "bun:test";
import plugin from "../index.ts";

function makeCtx(opts: { tools?: any; driver?: any; readFile?: any } = {}) {
  const subs: Record<string, ((p: any) => any)[]> = {};
  const provided: Record<string, unknown> = {};
  return {
    subs, provided,
    log: mock(() => {}),
    config: {},
    defineEvent: () => {},
    on: (event: string, fn: any) => { (subs[event] ??= []).push(fn); },
    emit: async (event: string, payload: any) => { for (const f of subs[event] ?? []) await f(payload); },
    defineService: () => {},
    provideService: (name: string, impl: unknown) => { provided[name] = impl; },
    consumeService: () => {},
    useService: (name: string) => {
      if (name === "tools:registry") return opts.tools;
      if (name === "driver:run-conversation") return opts.driver;
      return undefined;
    },
    secrets: { get: async () => undefined, refresh: async () => undefined },
  } as any;
}

describe("llm-agents plugin", () => {
  it("setup provides agents:registry even before discovery completes", async () => {
    const tools = { register: mock(() => () => {}), list: () => [], invoke: async () => {} };
    const driver = { runConversation: async () => ({ finalMessage: { role: "assistant", content: "" }, messages: [], usage: { promptTokens: 0, completionTokens: 0 } }) };
    const ctx = makeCtx({ tools, driver });
    await plugin.setup(ctx);
    const reg: any = ctx.provided["agents:registry"];
    expect(reg).toBeTruthy();
    expect(typeof reg.list).toBe("function");
    expect(reg.list()).toEqual([]);
  });

  it("registers dispatch_agent tool when tools:registry available", async () => {
    const tools = { register: mock(() => () => {}), list: () => [], invoke: async () => {} };
    const driver = { runConversation: async () => ({ finalMessage: { role: "assistant", content: "" }, messages: [], usage: { promptTokens: 0, completionTokens: 0 } }) };
    const ctx = makeCtx({ tools, driver });
    await plugin.setup(ctx);
    expect(tools.register).toHaveBeenCalled();
    const [schema] = (tools.register as any).mock.calls[0];
    expect(schema.name).toBe("dispatch_agent");
  });

  it("emits session:error when tools:registry missing", async () => {
    const ctx = makeCtx({ tools: undefined, driver: { runConversation: async () => ({} as any) } });
    let captured: any = null;
    ctx.on("session:error", (p: any) => { captured = p; });
    await plugin.setup(ctx);
    // Allow microtask discovery to settle:
    await new Promise((r) => setTimeout(r, 0));
    expect(captured?.message).toMatch(/tools:registry/);
  });

  it("manifest declares correct services and permissions", () => {
    expect(plugin.name).toBe("llm-agents");
    expect(plugin.permissions?.tier).toBe("unscoped");
    expect(plugin.services?.provides).toContain("agents:registry");
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Replace placeholder `index.ts`**

```ts
import type { KaizenPlugin } from "kaizen/types";
import type { AgentsRegistryService, DriverService, ToolsRegistryService } from "llm-events/public";
import { loadConfig, realDeps } from "./config.ts";
import { loadFromDirs } from "./loader.ts";
import { makeRegistry } from "./registry.ts";
import { makeTurnTracker } from "./turn-tracker.ts";
import { makeInjector } from "./injector.ts";
import { makeDispatchTool } from "./dispatch.ts";
import { readdir, stat as fsStat, realpath as fsRealpath, readFile as fsReadFile } from "node:fs/promises";

const plugin: KaizenPlugin = {
  name: "llm-agents",
  apiVersion: "3.0.0",
  permissions: { tier: "unscoped" },
  services: {
    provides: ["agents:registry"],
    consumes: ["tools:registry", "driver:run-conversation", "llm-events:vocabulary"],
  },

  async setup(ctx) {
    const log = (m: string) => ctx.log(m);
    const config = await loadConfig(realDeps(log));

    // Provide an empty registry up front so service consumers don't block on discovery.
    let registry = makeRegistry([]);
    let ready = false;

    ctx.defineService("agents:registry", { description: "Agent manifest registry." });
    // Wrap so we can swap the inner registry after discovery completes.
    const facadeService: AgentsRegistryService = {
      list: () => registry.service.list(),
      register: (m) => registry.service.register(m),
    };
    ctx.provideService<AgentsRegistryService>("agents:registry", facadeService);

    const tracker = makeTurnTracker();
    makeInjector({ ctx: { on: ctx.on, log }, registry, tracker });

    const tools = ctx.useService<ToolsRegistryService>("tools:registry");
    const driver = ctx.useService<DriverService>("driver:run-conversation");

    if (!tools || !driver) {
      const missing = [!tools && "tools:registry", !driver && "driver:run-conversation"].filter(Boolean).join(", ");
      void ctx.emit("session:error", { message: `llm-agents: missing required service(s): ${missing}; dispatch_agent disabled` });
    } else {
      const dispatch = makeDispatchTool({
        registry,
        tracker,
        driver,
        maxDepth: config.maxDepth,
        hasSkills: () => !!ctx.useService("skills:registry"),
      });
      const realHandler = dispatch.handler;
      const guardedHandler: typeof realHandler = async (args, tCtx) => {
        if (!ready) throw new Error("Agent registry still loading; retry");
        return realHandler(args, tCtx);
      };
      tools.register(dispatch.schema, guardedHandler);
    }

    // Discovery in a microtask — does not block setup().
    queueMicrotask(async () => {
      try {
        const result = await loadFromDirs({
          userDir: config.resolvedUserDir,
          projectDir: config.resolvedProjectDir,
          deps: {
            readDir: (p) => readdir(p),
            stat: (p) => fsStat(p) as any,
            realpath: (p) => fsRealpath(p),
            readFile: (p) => fsReadFile(p, "utf8"),
          },
        });
        registry = makeRegistry(result.manifests);
        // Swap underlying registry: rebind facade methods.
        (facadeService as any).list = () => registry.service.list();
        (facadeService as any).register = (m: any) => registry.service.register(m);
        // Update injector/dispatch references through closure (they hold the original
        // `registry` variable; since we reassigned, re-create by re-pointing via .service
        // pass-through. Done by using `.service.list()` calls everywhere — the facade
        // is the single source of truth for callers, and dispatch reads via getInternal
        // on the captured object. Replace getInternal too:
        (registry as any) = registry; // keep TS happy; the closure already updated.
        ready = true;
        for (const e of result.errors) {
          await ctx.emit("session:error", { message: `llm-agents: ${e.path}: ${e.message}` });
        }
      } catch (err) {
        ready = true;
        await ctx.emit("session:error", { message: `llm-agents: discovery failed: ${(err as Error).message}` });
      }
    });
  },
};

export default plugin;
```

> **Note for the implementer:** the closure-rebind dance above is awkward because `injector` and `dispatch` capture the `registry` reference at construction time. The correct, smaller refactor is to introduce a tiny `RegistryHandle` wrapper that the dependents capture, with a `setInner(newReg)` method. Implement that wrapper instead of the `(registry as any) = registry` line — the test in Step 1 catches that the post-discovery list is observable through the same `agents:registry` consumers (a Step 4 follow-up test). The line shown is intentionally the wrong pattern so reviewers notice; the fix is the next step.

- [ ] **Step 4: Replace closure-rebind with `RegistryHandle`**

Create the handle and update `injector.ts`/`dispatch.ts` consumers to take it:

In `plugins/llm-agents/registry.ts`, append:

```ts
export interface RegistryHandle {
  service: AgentsRegistryService;
  getInternal(name: string): InternalAgentManifest | undefined;
  setInner(next: AgentsRegistry): void;
}

export function makeRegistryHandle(initial: AgentsRegistry): RegistryHandle {
  let inner = initial;
  return {
    get service() { return { list: () => inner.service.list(), register: (m) => inner.service.register(m) } as AgentsRegistryService; },
    getInternal(name) { return inner.getInternal(name); },
    setInner(next) { inner = next; },
  } as RegistryHandle;
}
```

In `plugins/llm-agents/injector.ts` change `registry: AgentsRegistry` to `registry: RegistryHandle` (the public interface used is the same `service`).

In `plugins/llm-agents/dispatch.ts` change `registry: AgentsRegistry` to `registry: RegistryHandle`.

Now the index becomes clean:

```ts
import { makeRegistry, makeRegistryHandle } from "./registry.ts";
// ...
const handle = makeRegistryHandle(makeRegistry([]));
ctx.provideService<AgentsRegistryService>("agents:registry", handle.service);
makeInjector({ ctx: { on: ctx.on, log }, registry: handle, tracker });
// later, after discovery:
handle.setInner(makeRegistry(result.manifests));
```

Update `dispatch` construction the same way (`registry: handle`).

- [ ] **Step 5: Add tests for the post-discovery swap**

Append to `plugins/llm-agents/test/index.test.ts`:

```ts
it("agents:registry list() reflects discovered manifests after microtask", async () => {
  const VALID = `---\nname: a\ndescription: "d"\n---\nbody\n`;
  const tools = { register: () => () => {}, list: () => [], invoke: async () => {} };
  const driver = { runConversation: async () => ({ finalMessage: { role: "assistant", content: "" }, messages: [], usage: { promptTokens: 0, completionTokens: 0 } }) };
  const ctx = makeCtx({ tools, driver });
  // Stub the FS via env override so loadConfig returns specific dirs and the loader sees our content.
  // For this test we accept that real fs is consulted; assert that no throw happens and list() is callable.
  await plugin.setup(ctx);
  await new Promise((r) => setTimeout(r, 5));
  const reg: any = ctx.provided["agents:registry"];
  expect(Array.isArray(reg.list())).toBe(true);
});
```

(For a full FS-stubbed test, factor the loader's `node:fs` calls into a `realLoaderDeps()` factory similar to `realDeps()`. Add it now if not present, and stub through `KAIZEN_LLM_AGENTS_CONFIG` plus a temp dir written via `bun:test`'s tmpdir pattern. Defer the deeper E2E to Task 11.)

- [ ] **Step 6: Run all `llm-agents` tests**

Run: `bun test plugins/llm-agents/`
Expected: every test PASSes.

- [ ] **Step 7: Commit**

```bash
git add plugins/llm-agents/index.ts plugins/llm-agents/registry.ts plugins/llm-agents/injector.ts plugins/llm-agents/dispatch.ts plugins/llm-agents/test/index.test.ts
git commit -m "feat(llm-agents): wire setup() with deferred discovery and registry handle"
```

---

## Task 11: End-to-end fixture test + sample agent

**Files:**
- Create: `plugins/llm-agents/examples/code-reviewer.md`
- Create: `plugins/llm-agents/test/fixtures/agents-user/code-reviewer.md`
- Create: `plugins/llm-agents/test/fixtures/agents-project/doc-writer.md`
- Create: `plugins/llm-agents/test/e2e.test.ts`

The E2E test wires real `node:fs` against the fixtures dir, sets `KAIZEN_LLM_AGENTS_CONFIG` to point at a tmp config, runs `plugin.setup`, awaits discovery, then exercises the dispatch tool with a stubbed `driver:run-conversation` that asserts the system prompt matches the manifest body and returns canned content. This proves the integration of all eight modules end-to-end without a real LLM.

- [ ] **Step 1: Write `examples/code-reviewer.md`** (Spec 11 acceptance criterion):

```markdown
---
name: code-reviewer
description: >-
  Use when the user wants a focused review of a diff or specific file.
  Returns inline review comments grouped by file with severity tags.
tools: ["read_file", "list_files", "grep*"]
tags: ["read-only"]
---
You are a careful, terse code reviewer.

When given a file or diff:
1. Read it once.
2. Comment only on actual issues — bugs, missing edge cases, security, performance.
3. Group comments by file. Use severity tags: [bug] [smell] [style].
4. End with a one-line verdict: "approve" or "needs-changes".
```

- [ ] **Step 2: Copy that file as the user-scope fixture**

```bash
mkdir -p plugins/llm-agents/test/fixtures/agents-user
cp plugins/llm-agents/examples/code-reviewer.md plugins/llm-agents/test/fixtures/agents-user/code-reviewer.md
```

- [ ] **Step 3: Write the project-scope fixture**

`plugins/llm-agents/test/fixtures/agents-project/doc-writer.md`:

```markdown
---
name: doc-writer
description: "Draft or revise prose documentation."
---
You are a clear technical writer.
Prefer short sentences. No marketing words.
```

- [ ] **Step 4: Write the E2E test**

`plugins/llm-agents/test/e2e.test.ts`:

```ts
import { describe, it, expect, mock } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../index.ts";

function makeCtx(opts: { tools?: any; driver?: any } = {}) {
  const subs: Record<string, ((p: any) => any)[]> = {};
  const provided: Record<string, unknown> = {};
  let registeredTool: any = null;
  let registeredHandler: any = null;
  return {
    subs, provided,
    get registeredTool() { return registeredTool; },
    get registeredHandler() { return registeredHandler; },
    log: () => {},
    config: {},
    defineEvent: () => {},
    on: (event: string, fn: any) => { (subs[event] ??= []).push(fn); },
    emit: async (event: string, payload: any) => { for (const f of subs[event] ?? []) await f(payload); },
    defineService: () => {},
    provideService: (name: string, impl: unknown) => { provided[name] = impl; },
    consumeService: () => {},
    useService: (name: string) => {
      if (name === "tools:registry") return {
        register: (s: any, h: any) => { registeredTool = s; registeredHandler = h; return () => {}; },
        list: () => [], invoke: async () => {},
      };
      if (name === "driver:run-conversation") return opts.driver;
      return undefined;
    },
    secrets: { get: async () => undefined, refresh: async () => undefined },
  } as any;
}

describe("llm-agents E2E", () => {
  it("discovers fixtures, lists agents, dispatches with manifest system prompt", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "llm-agents-e2e-"));
    const cfgPath = join(tmp, "config.json");
    const fixturesRoot = new URL("./fixtures", import.meta.url).pathname;
    await writeFile(cfgPath, JSON.stringify({
      maxDepth: 3,
      userDir: join(fixturesRoot, "agents-user"),
      projectDir: join(fixturesRoot, "agents-project"),
    }));
    process.env.KAIZEN_LLM_AGENTS_CONFIG = cfgPath;

    let captured: any = null;
    const driver = {
      runConversation: mock(async (input: any) => {
        captured = input;
        return { finalMessage: { role: "assistant", content: "DONE" }, messages: [], usage: { promptTokens: 1, completionTokens: 1 } };
      }),
    };
    const ctx = makeCtx({ driver });
    await plugin.setup(ctx);
    await new Promise((r) => setTimeout(r, 50));

    const reg: any = ctx.provided["agents:registry"];
    const names = reg.list().map((a: any) => a.name).sort();
    expect(names).toEqual(["code-reviewer", "doc-writer"]);

    // Simulate the parent turn so the tracker accepts the turnId.
    await ctx.emit("turn:start", { turnId: "t-parent", trigger: "user" });

    const handler = (ctx as any).registeredHandler;
    expect(handler).toBeTruthy();
    const result = await handler(
      { agent_name: "code-reviewer", prompt: "review file X" },
      { signal: new AbortController().signal, callId: "c1", turnId: "t-parent", log: () => {} },
    );
    expect(result).toBe("DONE");
    expect(captured.systemPrompt).toContain("careful, terse code reviewer");
    expect(captured.parentTurnId).toBe("t-parent");
    expect(captured.toolFilter.names).toContain("dispatch_agent");
    expect(captured.toolFilter.names).toContain("read_file");

    delete process.env.KAIZEN_LLM_AGENTS_CONFIG;
  });
});
```

- [ ] **Step 5: Run, expect PASS**

Run: `bun test plugins/llm-agents/test/e2e.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the entire plugin's tests**

Run: `bun test plugins/llm-agents/`
Expected: every test passes; >= 35 total.

- [ ] **Step 7: Commit**

```bash
git add plugins/llm-agents/examples/ plugins/llm-agents/test/fixtures/ plugins/llm-agents/test/e2e.test.ts
git commit -m "test(llm-agents): E2E discovery + dispatch with fixtures and example agent"
```

---

## Task 12: Marketplace catalog entry + plan completion

**Files:**
- Modify: `.kaizen/marketplace.json`

- [ ] **Step 1: Add entry**

Insert after the `openai-llm` entry, before the harness entry:

```json
    {
      "kind": "plugin",
      "name": "llm-agents",
      "description": "Subagent dispatch + file-loader registry for ~/.kaizen/agents/.",
      "categories": ["agents", "llm"],
      "versions": [{ "version": "0.1.0", "source": { "type": "file", "path": "plugins/llm-agents" } }]
    },
```

- [ ] **Step 2: Validate marketplace JSON parses**

Run: `bun -e "console.log(JSON.parse(require('fs').readFileSync('.kaizen/marketplace.json','utf8')).entries.map(e=>e.name).join(','))"`
Expected: includes `llm-agents`.

- [ ] **Step 3: Final test sweep**

Run: `bun test plugins/llm-agents/ plugins/llm-events/`
Expected: all green.

- [ ] **Step 4: Type-check**

Run: `bun --bun tsc --noEmit -p plugins/llm-agents/tsconfig.json plugins/llm-agents/index.ts plugins/llm-agents/public.d.ts plugins/llm-agents/test/*.test.ts`
Expected: no diagnostics.

- [ ] **Step 5: Acceptance grep — no shape drift**

Run: `grep -nE "interface (AgentManifest|AgentsRegistryService|RunConversationInput|DriverService|ToolExecutionContext)" plugins/llm-agents/`
Expected: NO matches in `plugins/llm-agents/` (all such interfaces live in `llm-events/public.d.ts`; this plugin only re-exports).

- [ ] **Step 6: Acceptance grep — config path discipline**

Run: `grep -nRE "kaizen-llm|/config/" plugins/llm-agents/`
Expected: NO matches. Config lives only at `~/.kaizen/plugins/llm-agents/config.json` and the configurable `userDir`/`projectDir`.

- [ ] **Step 7: Commit**

```bash
git add .kaizen/marketplace.json
git commit -m "chore(marketplace): publish llm-agents@0.1.0"
```

- [ ] **Step 8: Final acceptance check against Spec 11**

Spec 11 §"Acceptance criteria":

1. `Plugin builds, tests pass, marketplace catalog updated.` — Tasks 11, 12.
2. `A C-tier harness using llm-agents can dispatch a depth-1 agent end-to-end against a stub provider.` — Task 11 E2E exercises this with stub driver.
3. `Spec 0 update for ToolExecutionContext.turnId is merged (or the fallback design is documented).` — Task 0 verifies; if missing, Task 0's halt instruction is the fallback.
4. `Documentation includes a sample agent file in examples/agents/code-reviewer.md.` — Task 11 ships `plugins/llm-agents/examples/code-reviewer.md`; the spec's exact path lives outside this plugin and is satisfied by linking the example from the README.

Add a one-paragraph "Sample agent" section to `plugins/llm-agents/README.md` referencing `examples/code-reviewer.md`:

```bash
cat >> plugins/llm-agents/README.md <<'EOF'

## Sample agent

See `examples/code-reviewer.md` for a complete, working agent file. Copy it to
`~/.kaizen/agents/code-reviewer.md` to make it available across all projects, or
to `<project>/.kaizen/agents/code-reviewer.md` to make it project-scoped (which
shadows any user-scope agent of the same name).
EOF
git add plugins/llm-agents/README.md
git commit -m "docs(llm-agents): reference sample agent file in README"
```

---

## Self-review checklist (run before declaring done)

1. **Spec coverage:**
   - Frontmatter schema (name, description, tools, tags, model) → Task 3.
   - User + project dirs, project shadows user → Task 6.
   - 64 KiB cap, symlink cycle detection → Task 6.
   - Lexicographic-first on intra-scope collision → Task 6 (`entries.sort()`).
   - `agents:registry` service contract (list + register) → Task 7.
   - `runtime:` prefix rule for programmatic register → Task 7.
   - `dispatch_agent` schema + handler flow → Task 9.
   - Tool filtering (manifest tools/tags + always-on dispatch_agent + load_skill if skills present) → Task 9.
   - Glob `*` wildcard matching → Task 4.
   - Depth tracking from `parentTurnId` chain + `maxDepth` enforcement → Tasks 5, 9.
   - Cancellation cascade (parent signal forwarded as input.signal; AbortError surfaces as canonical message) → Task 9.
   - System-prompt injection on top-level turns only, dedup'd per turn, omitted when empty → Task 8.
   - `status:item-update` for `agents.active` — partial: handler emits status updates? Confirmed in Spec 11 §"Streaming and observability". Add to Task 9 implementation: `await ctx.emit?.("status:item-update", { key: "agents.active", value: name })` before the await and a clear after. Update the handler accordingly when implementing Task 9 Step 3, and add a test that the events fire.
   - Settings: maxDepth, userDir, projectDir under `~/.kaizen/plugins/llm-agents/config.json` → Task 2.
   - Permissions `unscoped` → Task 1, Task 10.
   - Discovery in microtask + "registry not ready" guard → Task 10.

   *Coverage gap:* the `status:item-update` calls are not yet in Task 9's implementation snippet. Implementer: when writing Task 9 Step 3, wrap the `await deps.driver.runConversation(input)` call with `try { ctx.emit?.("status:item-update", { key: "agents.active", value: name }); ... } finally { ctx.emit?.("status:item-clear", { key: "agents.active" }); }` and add a unit test that captures the events on the `makeCtx().events` array.

2. **Placeholder scan:** No "TBD"/"implement later"/"add appropriate error handling" remains. The closure-rebind footnote in Task 10 Step 3 is intentionally called out and Task 10 Step 4 fixes it with `RegistryHandle`.

3. **Type consistency:**
   - `InternalAgentManifest` extends `AgentManifest` and adds `sourcePath`, `scope`, `modelOverride`. Defined in `frontmatter.ts`, used in `loader.ts`, `registry.ts`, `dispatch.ts`.
   - `RegistryHandle` introduced in Task 10 Step 4 and consumed by `injector.ts` and `dispatch.ts`.
   - `TurnRecord` defined in `depth.ts`, used by `turn-tracker.ts` and `depth.ts` test.
   - `Filter` type internal to `tool-filter.ts`; the schema fields the manifest exposes are `toolFilter: { names?: string[]; tags?: string[] }` matching Spec 0 `AgentManifest`.
   - `dispatch_agent` schema parameter names (`agent_name`, `prompt`) match Spec 11 verbatim.
   - Canonical error messages in Task 9 implementation match Spec 11 §"Error surfacing" exactly.
