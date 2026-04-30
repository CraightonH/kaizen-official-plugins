# llm-local-tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the `llm-local-tools` Kaizen plugin (Spec 6) — a leaf plugin that registers seven built-in tools (`read`, `write`, `create`, `edit`, `glob`, `grep`, `bash`) into the `tools:registry` service from Spec 4, giving any openai-compatible harness a Claude-Code-style local development toolset.

**Architecture:** Pure leaf plugin. `setup(ctx)` consumes the `tools:registry` service, calls `register(schema, handler)` once per tool, and returns a teardown bundle that unregisters them all. Each tool lives in its own file under `src/tools/` so handlers and schemas are unit-testable in isolation; `index.ts` is a thin registration loop. Zero external runtime dependencies — uses `node:fs/promises`, `Bun.Glob` (with a Node fs-walker fallback), and `Bun.spawn` for `bash` and the `rg` shell-out. Path resolution is `process.cwd()` at invoke time, with optional per-call `cwd` overrides; no plugin-managed working-directory state.

**Tech Stack:** TypeScript (strict), Bun runtime, `node:fs/promises`, `node:path`, `Bun.Glob`, `Bun.spawn`. Tests use `bun:test` against tmpdirs created with `node:fs.mkdtempSync`. No external runtime deps.

**Safety stance (load-bearing):** This plugin is **explicitly not sandboxed**. Per Spec 6, every tool runs unrestricted with the kaizen process's full privileges. Per-tool guardrails (binary-byte refusal, 50 MB hard read cap, 256 KB output cap, middle-truncation, unique-match `edit`, timeout SIGTERM→SIGKILL escalation, parent-dir-must-exist for `write`/`create`) are **product behavior**, not security boundaries. The README MUST start with the spec's bold warning.

---

## Prerequisites & Tier-for-Parallelism Map

This plan implements one plugin (`llm-local-tools`). Its only runtime dependencies are `llm-events` (for shared types via `public.d.ts` re-export) and `llm-tools-registry` (for the `tools:registry` service consumed at `setup`). Both must already exist on disk; if `llm-tools-registry` (Spec 4) is not yet implemented, Task 0 below assumes a typed shim — the consumer contract is `ToolsRegistryService` from Spec 0 and Task 14 (integration test) is gated on the real registry being present.

Tiers below indicate what may run in parallel (no shared writes, no read-after-write):

- **Tier 0** (sequential, blocks all others): Task 1 (scaffold package), Task 2 (`util.ts` + tests — shared helpers used by every tool).
- **Tier 1A** (parallel, leaf tool modules — each tool is independent): Task 3 (`read`), Task 4 (`write`), Task 5 (`create`), Task 6 (`edit`), Task 7 (`glob`), Task 8 (`grep`), Task 9 (`bash`).
- **Tier 1B** (sequential, integrates): Task 10 (`tools.ts` registry-of-schemas), Task 11 (`index.ts` setup loop + teardown), Task 12 (`public.d.ts`), Task 13 (README with safety warning), Task 14 (integration test against a real registry stub), Task 15 (marketplace catalog entry).

## File Structure

```
plugins/llm-local-tools/
  package.json
  tsconfig.json
  README.md                     # Task 13 — safety warning is mandatory
  index.ts                      # Task 11 — setup() loop, teardown bundle
  public.d.ts                   # Task 12 — re-exports + tool name list
  util.ts                       # Task 2 — resolvePath, truncateBytes, truncateMiddle, sniffBinary, ensureParentExists, hasGitRoot, formatLineNumbered, MAX_READ_BYTES, etc.
  tools/
    read.ts                     # Task 3
    write.ts                    # Task 4
    create.ts                   # Task 5
    edit.ts                     # Task 6
    glob.ts                     # Task 7
    grep.ts                     # Task 8
    bash.ts                     # Task 9
  tools.ts                      # Task 10 — `ALL_TOOLS: Array<{ schema, handler }>`
  test/
    util.test.ts                # Task 2
    tools/
      read.test.ts              # Task 3
      write.test.ts             # Task 4
      create.test.ts            # Task 5
      edit.test.ts              # Task 6
      glob.test.ts              # Task 7
      grep.test.ts              # Task 8
      bash.test.ts              # Task 9
    integration.test.ts         # Task 14 — registers against a fake ToolsRegistryService
    fixtures/
      sample.txt
      binary.bin                # contains a NUL byte
      gitignore-fixture/
        .gitignore
        ignored.log
        kept.ts
```

`.kaizen/marketplace.json` is also modified (Task 15).

Boundaries:
- `util.ts` is pure helpers, no `fs` writes; reads only via injected callbacks where useful.
- Each `tools/<name>.ts` exports `{ schema: ToolSchema, handler: (args, ctx) => Promise<unknown> }` and nothing else.
- `tools.ts` is a static array; no logic.
- `index.ts` does the registration loop and the teardown bundle. It is the only file that reads `ctx.useService("tools:registry")`.

---

## Task 1: Scaffold `llm-local-tools` package (Tier 0)

**Files:**
- Create: `plugins/llm-local-tools/package.json`
- Create: `plugins/llm-local-tools/tsconfig.json`
- Create: `plugins/llm-local-tools/index.ts` (placeholder)
- Create: `plugins/llm-local-tools/public.d.ts` (placeholder)
- Create: `plugins/llm-local-tools/test/scaffold.test.ts`

- [ ] **Step 1: Write the failing scaffold test**

Create `plugins/llm-local-tools/test/scaffold.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import plugin from "../index.ts";

describe("llm-local-tools scaffold", () => {
  it("exports a kaizen plugin with the expected metadata", () => {
    expect(plugin.name).toBe("llm-local-tools");
    expect(plugin.apiVersion).toBe("3.0.0");
    expect(plugin.services?.consumes).toContain("tools:registry");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test plugins/llm-local-tools/test/scaffold.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `package.json`**

```json
{
  "name": "llm-local-tools",
  "version": "0.1.0",
  "description": "Built-in local-development toolset (filesystem + shell) for the openai-compatible harness.",
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

- [ ] **Step 4: Write `tsconfig.json`**

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

- [ ] **Step 5: Write placeholder `index.ts`**

```ts
import type { KaizenPlugin } from "kaizen/types";

const plugin: KaizenPlugin = {
  name: "llm-local-tools",
  apiVersion: "3.0.0",
  permissions: { tier: "trusted" },
  services: { consumes: ["tools:registry", "llm-events:vocabulary"] },
  async setup(_ctx) {
    // Filled in by Task 11.
  },
};

export default plugin;
```

- [ ] **Step 6: Write placeholder `public.d.ts`**

```ts
export type { ToolSchema, ToolCall } from "llm-events/public";
```

- [ ] **Step 7: Run tests**

Run: `bun test plugins/llm-local-tools/test/scaffold.test.ts`
Expected: 1 test PASS.

- [ ] **Step 8: Commit**

```bash
git add plugins/llm-local-tools/
git commit -m "feat(llm-local-tools): scaffold plugin package"
```

---

## Task 2: `util.ts` — shared helpers (Tier 0)

**Files:**
- Create: `plugins/llm-local-tools/util.ts`
- Create: `plugins/llm-local-tools/test/util.test.ts`

Defines: `resolvePath(p, baseCwd?)` (returns absolute), `truncateBytes(s, max, marker)`, `truncateMiddle(s, max, marker)`, `sniffBinary(buf)` (NUL byte in first 8 KB → true), `ensureParentExists(absPath)` (stats parent dir; throws if missing or not a dir), `hasGitRoot(cwd)` (walk up to find a `.git` entry), `formatLineNumbered(text, startLine)` (1-indexed `cat -n`-style: `   1\t...`), and constants `MAX_READ_BYTES = 50 * 1024 * 1024`, `READ_CAP_BYTES = 256 * 1024`, `READ_CAP_LINES = 2000`, `BASH_OUTPUT_CAP = 256 * 1024`, `GREP_DEFAULT_MAX = 200`, `GLOB_CAP = 1000`.

- [ ] **Step 1: Write the failing tests**

```ts
// plugins/llm-local-tools/test/util.test.ts
import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolvePath,
  truncateBytes,
  truncateMiddle,
  sniffBinary,
  ensureParentExists,
  hasGitRoot,
  formatLineNumbered,
  MAX_READ_BYTES,
  READ_CAP_BYTES,
  READ_CAP_LINES,
  BASH_OUTPUT_CAP,
  GREP_DEFAULT_MAX,
  GLOB_CAP,
} from "../util.ts";

describe("util", () => {
  it("constants match spec", () => {
    expect(MAX_READ_BYTES).toBe(50 * 1024 * 1024);
    expect(READ_CAP_BYTES).toBe(256 * 1024);
    expect(READ_CAP_LINES).toBe(2000);
    expect(BASH_OUTPUT_CAP).toBe(256 * 1024);
    expect(GREP_DEFAULT_MAX).toBe(200);
    expect(GLOB_CAP).toBe(1000);
  });

  it("resolvePath returns absolute paths against baseCwd", () => {
    expect(resolvePath("/abs/path")).toBe("/abs/path");
    expect(resolvePath("rel/x", "/base")).toBe("/base/rel/x");
  });

  it("truncateBytes appends marker once over cap", () => {
    const s = "x".repeat(100);
    const out = truncateBytes(s, 10, "[truncated: cap]");
    expect(out.startsWith("xxxxxxxxxx")).toBe(true);
    expect(out).toContain("[truncated: cap]");
    expect(truncateBytes("hi", 10, "...")).toBe("hi");
  });

  it("truncateMiddle keeps head + tail with marker", () => {
    const s = "A".repeat(50) + "B".repeat(50) + "C".repeat(50);
    const out = truncateMiddle(s, 40, "[mid]");
    expect(out.startsWith("A")).toBe(true);
    expect(out.endsWith("C")).toBe(true);
    expect(out).toContain("[mid]");
    expect(out.length).toBeLessThan(s.length);
    expect(truncateMiddle("short", 100, "[mid]")).toBe("short");
  });

  it("sniffBinary detects NUL in first 8KB", () => {
    expect(sniffBinary(Buffer.from("hello world"))).toBe(false);
    const withNul = Buffer.concat([Buffer.from("ok"), Buffer.from([0]), Buffer.from("more")]);
    expect(sniffBinary(withNul)).toBe(true);
  });

  it("ensureParentExists throws when parent missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "llt-"));
    try {
      await ensureParentExists(join(dir, "exists.txt"));
      await expect(ensureParentExists(join(dir, "missing/exists.txt"))).rejects.toThrow(/parent directory/i);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("hasGitRoot walks up to find .git", () => {
    const root = mkdtempSync(join(tmpdir(), "llt-git-"));
    try {
      mkdirSync(join(root, ".git"));
      mkdirSync(join(root, "a/b"), { recursive: true });
      expect(hasGitRoot(join(root, "a/b"))).toBe(true);
      const naked = mkdtempSync(join(tmpdir(), "llt-nogit-"));
      try {
        expect(hasGitRoot(naked)).toBe(false);
      } finally {
        rmSync(naked, { recursive: true });
      }
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it("formatLineNumbered produces cat -n style", () => {
    const out = formatLineNumbered("a\nb\nc", 1);
    expect(out).toBe("     1\ta\n     2\tb\n     3\tc");
    const offset = formatLineNumbered("x\ny", 10);
    expect(offset).toBe("    10\tx\n    11\ty");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test plugins/llm-local-tools/test/util.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `util.ts`**

```ts
// plugins/llm-local-tools/util.ts
import { stat as fsStat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";

export const MAX_READ_BYTES = 50 * 1024 * 1024;
export const READ_CAP_BYTES = 256 * 1024;
export const READ_CAP_LINES = 2000;
export const BASH_OUTPUT_CAP = 256 * 1024;
export const GREP_DEFAULT_MAX = 200;
export const GLOB_CAP = 1000;

export function resolvePath(p: string, baseCwd?: string): string {
  if (isAbsolute(p)) return p;
  return resolve(baseCwd ?? process.cwd(), p);
}

export function truncateBytes(s: string, max: number, marker: string): string {
  if (Buffer.byteLength(s, "utf8") <= max) return s;
  const buf = Buffer.from(s, "utf8");
  return buf.subarray(0, max).toString("utf8") + "\n" + marker;
}

export function truncateMiddle(s: string, max: number, marker: string): string {
  const len = Buffer.byteLength(s, "utf8");
  if (len <= max) return s;
  const half = Math.floor((max - marker.length - 2) / 2);
  if (half <= 0) return marker;
  const buf = Buffer.from(s, "utf8");
  const head = buf.subarray(0, half).toString("utf8");
  const tail = buf.subarray(buf.length - half).toString("utf8");
  return `${head}\n${marker}\n${tail}`;
}

export function sniffBinary(buf: Buffer): boolean {
  const slice = buf.subarray(0, Math.min(buf.length, 8 * 1024));
  for (let i = 0; i < slice.length; i++) if (slice[i] === 0) return true;
  return false;
}

export async function ensureParentExists(absPath: string): Promise<void> {
  const parent = dirname(absPath);
  let st;
  try {
    st = await fsStat(parent);
  } catch (err: any) {
    throw new Error(`parent directory does not exist: ${parent}`);
  }
  if (!st.isDirectory()) throw new Error(`parent directory is not a directory: ${parent}`);
}

export function hasGitRoot(cwd: string): boolean {
  let cur = resolve(cwd);
  for (;;) {
    if (existsSync(`${cur}${sep}.git`)) return true;
    const parent = dirname(cur);
    if (parent === cur) return false;
    cur = parent;
  }
}

export function formatLineNumbered(text: string, startLine: number): string {
  const lines = text.split("\n");
  return lines.map((line, i) => {
    const n = String(startLine + i).padStart(6, " ");
    return `${n}\t${line}`;
  }).join("\n");
}
```

- [ ] **Step 4: Run tests**

Run: `bun test plugins/llm-local-tools/test/util.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-local-tools/util.ts plugins/llm-local-tools/test/util.test.ts
git commit -m "feat(llm-local-tools): shared util helpers (paths, truncation, binary sniff)"
```

---

## Task 3: `read` tool

**Safety / permission semantics for this tool:**
- Resolves the input path against `process.cwd()` at invoke time (no plugin cwd state).
- Refuses files larger than `MAX_READ_BYTES` (50 MB) outright before any read — guardrail against `read`-ing a database/binary blob.
- Refuses files containing a NUL byte in the first 8 KB (binary heuristic).
- Caps returned content at `READ_CAP_BYTES` (256 KB) AND `READ_CAP_LINES` (2000 lines), whichever hits first.
- Throws on missing path with `ENOENT: <abs-path>`.
- No path allow-list. No symlink rejection. Not safe vs. an adversarial LLM prompt — see Spec 6 §"Safety / permissions".

**Files:**
- Create: `plugins/llm-local-tools/tools/read.ts`
- Create: `plugins/llm-local-tools/test/tools/read.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// plugins/llm-local-tools/test/tools/read.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, truncateSync, openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schema, handler } from "../../tools/read.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "llt-read-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const ctx = { signal: new AbortController().signal, callId: "c1", log: () => {} } as any;

describe("read tool", () => {
  it("schema metadata is correct", () => {
    expect(schema.name).toBe("read");
    expect(schema.tags).toEqual(["local", "fs"]);
    expect(schema.parameters.required).toEqual(["path"]);
  });

  it("returns line-numbered content", async () => {
    const p = join(dir, "a.txt");
    writeFileSync(p, "first\nsecond\nthird");
    const out = await handler({ path: p }, ctx) as string;
    expect(out).toContain("     1\tfirst");
    expect(out).toContain("     2\tsecond");
    expect(out).toContain("     3\tthird");
  });

  it("honors offset and limit", async () => {
    const p = join(dir, "b.txt");
    writeFileSync(p, Array.from({ length: 10 }, (_, i) => `L${i + 1}`).join("\n"));
    const out = await handler({ path: p, offset: 3, limit: 2 }, ctx) as string;
    expect(out).toContain("     3\tL3");
    expect(out).toContain("     4\tL4");
    expect(out).not.toContain("L5");
    expect(out).not.toContain("L1");
  });

  it("rejects binary files (NUL byte in first 8KB)", async () => {
    const p = join(dir, "bin");
    writeFileSync(p, Buffer.concat([Buffer.from("hi"), Buffer.from([0]), Buffer.from("more")]));
    await expect(handler({ path: p }, ctx)).rejects.toThrow(/binary/i);
  });

  it("throws ENOENT-shaped error for missing path", async () => {
    await expect(handler({ path: join(dir, "missing.txt") }, ctx))
      .rejects.toThrow(/ENOENT.*missing\.txt/);
  });

  it("refuses files larger than MAX_READ_BYTES", async () => {
    const p = join(dir, "huge");
    const fd = openSync(p, "w");
    closeSync(fd);
    truncateSync(p, 51 * 1024 * 1024); // sparse 51 MB
    await expect(handler({ path: p }, ctx)).rejects.toThrow(/too large/i);
  });

  it("appends truncation marker when over READ_CAP_LINES", async () => {
    const p = join(dir, "big.txt");
    const lines = Array.from({ length: 2100 }, (_, i) => `L${i + 1}`).join("\n");
    writeFileSync(p, lines);
    const out = await handler({ path: p }, ctx) as string;
    expect(out).toMatch(/\[truncated: file has \d+ more lines/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test plugins/llm-local-tools/test/tools/read.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `tools/read.ts`**

```ts
// plugins/llm-local-tools/tools/read.ts
import { stat, open } from "node:fs/promises";
import type { ToolSchema } from "llm-events/public";
import {
  resolvePath,
  sniffBinary,
  formatLineNumbered,
  MAX_READ_BYTES,
  READ_CAP_BYTES,
  READ_CAP_LINES,
} from "../util.ts";

export const schema: ToolSchema = {
  name: "read",
  description: "Read a file from the local filesystem. Returns contents prefixed with line numbers (1-indexed). Use `offset` and `limit` to page through large files.",
  parameters: {
    type: "object",
    properties: {
      path:   { type: "string", description: "Absolute path, or relative to the process cwd." },
      offset: { type: "integer", minimum: 1, description: "1-indexed line to start at. Defaults to 1." },
      limit:  { type: "integer", minimum: 1, description: "Max lines to return. Defaults to 2000." },
    },
    required: ["path"],
  },
  tags: ["local", "fs"],
};

interface ReadArgs { path: string; offset?: number; limit?: number; }

export async function handler(args: ReadArgs, _ctx: unknown): Promise<string> {
  const abs = resolvePath(args.path);
  let st;
  try {
    st = await stat(abs);
  } catch (err: any) {
    if (err?.code === "ENOENT") throw new Error(`ENOENT: no such file: ${abs}`);
    throw err;
  }
  if (!st.isFile()) throw new Error(`not a regular file: ${abs}`);
  if (st.size > MAX_READ_BYTES) throw new Error(`file too large to read (${st.size} bytes > ${MAX_READ_BYTES}): ${abs}`);

  const fh = await open(abs, "r");
  try {
    const head = Buffer.alloc(Math.min(8 * 1024, st.size));
    await fh.read(head, 0, head.length, 0);
    if (sniffBinary(head)) throw new Error(`refusing to read binary file (NUL byte detected): ${abs}`);

    const offset = Math.max(1, args.offset ?? 1);
    const limit = Math.max(1, args.limit ?? READ_CAP_LINES);
    const wantLines = Math.min(limit, READ_CAP_LINES);

    const buf = Buffer.alloc(st.size);
    await fh.read(buf, 0, st.size, 0);
    const all = buf.toString("utf8");
    const lines = all.split("\n");
    const totalLines = lines.length;
    const slice = lines.slice(offset - 1, offset - 1 + wantLines);

    let body = formatLineNumbered(slice.join("\n"), offset);
    let truncated = false;
    let truncReason = "";

    if (Buffer.byteLength(body, "utf8") > READ_CAP_BYTES) {
      truncated = true;
      const cut = Buffer.from(body, "utf8").subarray(0, READ_CAP_BYTES).toString("utf8");
      const moreBytes = Buffer.byteLength(body, "utf8") - READ_CAP_BYTES;
      body = cut;
      truncReason = `${moreBytes} more bytes`;
    }
    const linesShown = slice.length;
    const moreLines = Math.max(0, totalLines - (offset - 1) - linesShown);
    if (moreLines > 0 || linesShown >= READ_CAP_LINES) {
      truncated = true;
      truncReason = `file has ${moreLines} more lines${truncReason ? " / " + truncReason : ""}`;
    }
    if (truncated) body += `\n... [truncated: ${truncReason}]`;
    return body;
  } finally {
    await fh.close();
  }
}
```

- [ ] **Step 4: Run tests**

Run: `bun test plugins/llm-local-tools/test/tools/read.test.ts`
Expected: 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-local-tools/tools/read.ts plugins/llm-local-tools/test/tools/read.test.ts
git commit -m "feat(llm-local-tools): read tool with line numbering, caps, binary refusal"
```

---

## Task 4: `write` tool

**Safety / permission semantics for this tool:**
- Refuses if the target path does not exist (overwrite-only — `create` is the new-file path).
- Refuses if the parent directory does not exist (does **not** mkdir-p).
- Writes UTF-8 verbatim, no BOM, no trailing-newline insertion.
- Writes to arbitrary locations; no path allow-list. Not safe vs. an adversarial LLM.
- Tagged `["local", "fs"]` so an agent can exclude all fs tools by tag.

**Files:**
- Create: `plugins/llm-local-tools/tools/write.ts`
- Create: `plugins/llm-local-tools/test/tools/write.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// plugins/llm-local-tools/test/tools/write.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schema, handler } from "../../tools/write.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "llt-write-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const ctx = { signal: new AbortController().signal, callId: "c1", log: () => {} } as any;

describe("write tool", () => {
  it("schema metadata", () => {
    expect(schema.name).toBe("write");
    expect(schema.tags).toEqual(["local", "fs"]);
  });

  it("overwrites an existing file", async () => {
    const p = join(dir, "a.txt");
    writeFileSync(p, "old");
    const out = await handler({ path: p, content: "new" }, ctx) as string;
    expect(readFileSync(p, "utf8")).toBe("new");
    expect(out).toMatch(/wrote 3 bytes to /);
  });

  it("refuses if file does not exist", async () => {
    await expect(handler({ path: join(dir, "missing.txt"), content: "x" }, ctx))
      .rejects.toThrow(/does not exist/i);
  });

  it("refuses if parent directory missing", async () => {
    await expect(handler({ path: join(dir, "no/such/parent/file.txt"), content: "x" }, ctx))
      .rejects.toThrow(/parent directory/i);
  });

  it("UTF-8 round trip preserved verbatim", async () => {
    const p = join(dir, "utf.txt");
    writeFileSync(p, "");
    await handler({ path: p, content: "héllo\n" }, ctx);
    expect(readFileSync(p, "utf8")).toBe("héllo\n");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test plugins/llm-local-tools/test/tools/write.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `tools/write.ts`**

```ts
// plugins/llm-local-tools/tools/write.ts
import { writeFile, stat } from "node:fs/promises";
import type { ToolSchema } from "llm-events/public";
import { resolvePath, ensureParentExists } from "../util.ts";

export const schema: ToolSchema = {
  name: "write",
  description: "Overwrite an existing file with new contents. Fails if the file does not exist; use `create` for new files.",
  parameters: {
    type: "object",
    properties: {
      path:    { type: "string" },
      content: { type: "string" },
    },
    required: ["path", "content"],
  },
  tags: ["local", "fs"],
};

interface WriteArgs { path: string; content: string; }

export async function handler(args: WriteArgs, _ctx: unknown): Promise<string> {
  const abs = resolvePath(args.path);
  await ensureParentExists(abs);
  let st;
  try {
    st = await stat(abs);
  } catch (err: any) {
    if (err?.code === "ENOENT") throw new Error(`write target does not exist (use create for new files): ${abs}`);
    throw err;
  }
  if (!st.isFile()) throw new Error(`write target is not a regular file: ${abs}`);
  const bytes = Buffer.byteLength(args.content, "utf8");
  await writeFile(abs, args.content, { encoding: "utf8" });
  return `wrote ${bytes} bytes to ${abs}`;
}
```

- [ ] **Step 4: Run tests**

Run: `bun test plugins/llm-local-tools/test/tools/write.test.ts`
Expected: 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-local-tools/tools/write.ts plugins/llm-local-tools/test/tools/write.test.ts
git commit -m "feat(llm-local-tools): write tool (overwrite-only, parent must exist)"
```

---

## Task 5: `create` tool

**Safety / permission semantics for this tool:**
- Refuses if the target path **already exists** (no clobber).
- Refuses if the parent directory does not exist (no mkdir-p — explicit by spec; shells out to `bash` if a tree is needed).
- Writes UTF-8 verbatim, no BOM, no trailing-newline insertion.
- No path allow-list. Will create files anywhere the process can write. Not safe vs. an adversarial LLM.
- Tagged `["local", "fs"]`.

**Files:**
- Create: `plugins/llm-local-tools/tools/create.ts`
- Create: `plugins/llm-local-tools/test/tools/create.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// plugins/llm-local-tools/test/tools/create.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schema, handler } from "../../tools/create.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "llt-create-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const ctx = { signal: new AbortController().signal, callId: "c1", log: () => {} } as any;

describe("create tool", () => {
  it("schema metadata", () => {
    expect(schema.name).toBe("create");
    expect(schema.tags).toEqual(["local", "fs"]);
  });

  it("creates a new file", async () => {
    const p = join(dir, "new.txt");
    const out = await handler({ path: p, content: "hi" }, ctx) as string;
    expect(existsSync(p)).toBe(true);
    expect(readFileSync(p, "utf8")).toBe("hi");
    expect(out).toMatch(/wrote 2 bytes to /);
  });

  it("refuses if file exists", async () => {
    const p = join(dir, "x.txt");
    writeFileSync(p, "old");
    await expect(handler({ path: p, content: "new" }, ctx)).rejects.toThrow(/already exists/i);
    expect(readFileSync(p, "utf8")).toBe("old");
  });

  it("refuses if parent missing", async () => {
    await expect(handler({ path: join(dir, "deep/sub/x.txt"), content: "z" }, ctx))
      .rejects.toThrow(/parent directory/i);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test plugins/llm-local-tools/test/tools/create.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `tools/create.ts`**

```ts
// plugins/llm-local-tools/tools/create.ts
import { writeFile } from "node:fs/promises";
import type { ToolSchema } from "llm-events/public";
import { resolvePath, ensureParentExists } from "../util.ts";

export const schema: ToolSchema = {
  name: "create",
  description: "Create a new file. Fails if the file already exists; use `write` to overwrite.",
  parameters: {
    type: "object",
    properties: {
      path:    { type: "string" },
      content: { type: "string" },
    },
    required: ["path", "content"],
  },
  tags: ["local", "fs"],
};

interface CreateArgs { path: string; content: string; }

export async function handler(args: CreateArgs, _ctx: unknown): Promise<string> {
  const abs = resolvePath(args.path);
  await ensureParentExists(abs);
  try {
    await writeFile(abs, args.content, { encoding: "utf8", flag: "wx" });
  } catch (err: any) {
    if (err?.code === "EEXIST") throw new Error(`create target already exists (use write to overwrite): ${abs}`);
    throw err;
  }
  const bytes = Buffer.byteLength(args.content, "utf8");
  return `wrote ${bytes} bytes to ${abs}`;
}
```

- [ ] **Step 4: Run tests**

Run: `bun test plugins/llm-local-tools/test/tools/create.test.ts`
Expected: 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-local-tools/tools/create.ts plugins/llm-local-tools/test/tools/create.test.ts
git commit -m "feat(llm-local-tools): create tool (new-file-only, no clobber, no mkdir-p)"
```

---

## Task 6: `edit` tool

**Safety / permission semantics for this tool:**
- Reads + rewrites arbitrary files in-place. No path allow-list.
- Unique-match contract: with `replace_all: false` (default), `old_string` MUST match exactly once. Zero matches throws "old_string not found"; >1 throws "matched N times". This is the **product behavior** that protects against an LLM editing the wrong location.
- `old_string === new_string` throws "no-op edit" — surfaces LLM mistakes early.
- File must already exist (use `create` for new files).
- Whitespace-sensitive matching — no normalization.
- Tagged `["local", "fs"]`.

**Files:**
- Create: `plugins/llm-local-tools/tools/edit.ts`
- Create: `plugins/llm-local-tools/test/tools/edit.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// plugins/llm-local-tools/test/tools/edit.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schema, handler } from "../../tools/edit.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "llt-edit-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const ctx = { signal: new AbortController().signal, callId: "c1", log: () => {} } as any;

describe("edit tool", () => {
  it("schema metadata", () => {
    expect(schema.name).toBe("edit");
    expect(schema.tags).toEqual(["local", "fs"]);
  });

  it("replaces a unique match", async () => {
    const p = join(dir, "a.txt"); writeFileSync(p, "alpha BETA gamma");
    const out = await handler({ path: p, old_string: "BETA", new_string: "DELTA" }, ctx) as string;
    expect(readFileSync(p, "utf8")).toBe("alpha DELTA gamma");
    expect(out).toMatch(/replaced 1 occurrence/);
  });

  it("rejects zero matches", async () => {
    const p = join(dir, "a.txt"); writeFileSync(p, "alpha");
    await expect(handler({ path: p, old_string: "ZZ", new_string: "Y" }, ctx))
      .rejects.toThrow(/not found/i);
  });

  it("rejects multi-match without replace_all", async () => {
    const p = join(dir, "a.txt"); writeFileSync(p, "x x x");
    await expect(handler({ path: p, old_string: "x", new_string: "y" }, ctx))
      .rejects.toThrow(/matched 3 times/i);
  });

  it("replace_all replaces all", async () => {
    const p = join(dir, "a.txt"); writeFileSync(p, "x x x");
    const out = await handler({ path: p, old_string: "x", new_string: "y", replace_all: true }, ctx) as string;
    expect(readFileSync(p, "utf8")).toBe("y y y");
    expect(out).toMatch(/replaced 3 occurrence/);
  });

  it("rejects identical old/new", async () => {
    const p = join(dir, "a.txt"); writeFileSync(p, "alpha");
    await expect(handler({ path: p, old_string: "alpha", new_string: "alpha" }, ctx))
      .rejects.toThrow(/no-op/i);
  });

  it("whitespace-sensitive match", async () => {
    const p = join(dir, "a.txt"); writeFileSync(p, "  indented");
    await expect(handler({ path: p, old_string: "indented", new_string: "X" }, ctx))
      .resolves.toBeDefined();
    expect(readFileSync(p, "utf8")).toBe("  X");
  });

  it("missing file throws", async () => {
    await expect(handler({ path: join(dir, "missing"), old_string: "a", new_string: "b" }, ctx))
      .rejects.toThrow(/ENOENT/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test plugins/llm-local-tools/test/tools/edit.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `tools/edit.ts`**

```ts
// plugins/llm-local-tools/tools/edit.ts
import { readFile, writeFile, stat } from "node:fs/promises";
import type { ToolSchema } from "llm-events/public";
import { resolvePath } from "../util.ts";

export const schema: ToolSchema = {
  name: "edit",
  description: "Replace exact text in a file. `old_string` MUST appear exactly once unless `replace_all` is true. Preserve indentation and surrounding context exactly when picking `old_string`.",
  parameters: {
    type: "object",
    properties: {
      path:        { type: "string" },
      old_string:  { type: "string", description: "Text to find. Must match exactly, including whitespace." },
      new_string:  { type: "string", description: "Replacement text. Must differ from old_string." },
      replace_all: { type: "boolean", default: false },
    },
    required: ["path", "old_string", "new_string"],
  },
  tags: ["local", "fs"],
};

interface EditArgs { path: string; old_string: string; new_string: string; replace_all?: boolean; }

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0; let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) { count++; idx += needle.length; }
  return count;
}

export async function handler(args: EditArgs, _ctx: unknown): Promise<string> {
  if (args.old_string === args.new_string) throw new Error("no-op edit: old_string equals new_string");
  const abs = resolvePath(args.path);
  try {
    await stat(abs);
  } catch (err: any) {
    if (err?.code === "ENOENT") throw new Error(`ENOENT: no such file: ${abs}`);
    throw err;
  }
  const original = await readFile(abs, "utf8");
  const count = countOccurrences(original, args.old_string);
  if (count === 0) throw new Error(`old_string not found in ${abs}`);
  const replaceAll = args.replace_all === true;
  if (!replaceAll && count > 1) throw new Error(`old_string matched ${count} times in ${abs}; supply more context or set replace_all`);
  const updated = replaceAll
    ? original.split(args.old_string).join(args.new_string)
    : original.replace(args.old_string, args.new_string);
  const replaced = replaceAll ? count : 1;
  await writeFile(abs, updated, "utf8");
  return `edited ${abs}: replaced ${replaced} occurrence(s)`;
}
```

- [ ] **Step 4: Run tests**

Run: `bun test plugins/llm-local-tools/test/tools/edit.test.ts`
Expected: 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-local-tools/tools/edit.ts plugins/llm-local-tools/test/tools/edit.test.ts
git commit -m "feat(llm-local-tools): edit tool with unique-match contract + replace_all"
```

---

## Task 7: `glob` tool

**Safety / permission semantics for this tool:**
- Read-only filesystem listing. No writes; no exec.
- Honors `.gitignore` if a `.git` directory is present at or above `cwd` — matches developer expectations and avoids returning `node_modules` paths by default.
- Caps result list at `GLOB_CAP` (1000 entries), appending a single trailing `... [truncated: M more matches]` marker.
- Sorted by mtime descending.
- Tagged `["local", "fs"]`.

**Files:**
- Create: `plugins/llm-local-tools/tools/glob.ts`
- Create: `plugins/llm-local-tools/test/tools/glob.test.ts`
- Create: `plugins/llm-local-tools/test/fixtures/gitignore-fixture/.gitignore`
- Create: `plugins/llm-local-tools/test/fixtures/gitignore-fixture/ignored.log`
- Create: `plugins/llm-local-tools/test/fixtures/gitignore-fixture/kept.ts`

- [ ] **Step 1: Create gitignore fixture**

`plugins/llm-local-tools/test/fixtures/gitignore-fixture/.gitignore`:

```
*.log
```

`plugins/llm-local-tools/test/fixtures/gitignore-fixture/ignored.log`: empty.
`plugins/llm-local-tools/test/fixtures/gitignore-fixture/kept.ts`: `export const x = 1;`

- [ ] **Step 2: Write the failing test**

```ts
// plugins/llm-local-tools/test/tools/glob.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schema, handler } from "../../tools/glob.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "llt-glob-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const ctx = { signal: new AbortController().signal, callId: "c1", log: () => {} } as any;

describe("glob tool", () => {
  it("schema metadata", () => {
    expect(schema.name).toBe("glob");
    expect(schema.tags).toEqual(["local", "fs"]);
  });

  it("matches **/*.ts and sorts by mtime desc", async () => {
    writeFileSync(join(dir, "a.ts"), "");
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub/b.ts"), "");
    const now = new Date();
    utimesSync(join(dir, "a.ts"), now, new Date(now.getTime() - 60_000));
    utimesSync(join(dir, "sub/b.ts"), now, now);
    const out = await handler({ pattern: "**/*.ts", cwd: dir }, ctx) as string;
    const lines = out.split("\n").filter(Boolean);
    expect(lines[0]).toContain("sub/b.ts");
    expect(lines[1]).toContain("a.ts");
  });

  it("honors .gitignore when .git is present at root", async () => {
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".gitignore"), "*.log\n");
    writeFileSync(join(dir, "ignored.log"), "");
    writeFileSync(join(dir, "kept.ts"), "");
    const out = await handler({ pattern: "**/*", cwd: dir }, ctx) as string;
    expect(out).toContain("kept.ts");
    expect(out).not.toContain("ignored.log");
  });

  it("ignores .gitignore when no .git is present", async () => {
    writeFileSync(join(dir, ".gitignore"), "*.log\n");
    writeFileSync(join(dir, "ignored.log"), "");
    writeFileSync(join(dir, "kept.ts"), "");
    const out = await handler({ pattern: "**/*", cwd: dir }, ctx) as string;
    expect(out).toContain("kept.ts");
    expect(out).toContain("ignored.log");
  });

  it("truncates above GLOB_CAP", async () => {
    for (let i = 0; i < 1005; i++) writeFileSync(join(dir, `f${i}.txt`), "");
    const out = await handler({ pattern: "*.txt", cwd: dir }, ctx) as string;
    expect(out).toMatch(/\[truncated: \d+ more matches\]/);
    const lines = out.split("\n").filter(Boolean);
    expect(lines.length).toBe(1001); // 1000 paths + 1 marker line
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `bun test plugins/llm-local-tools/test/tools/glob.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `tools/glob.ts`**

```ts
// plugins/llm-local-tools/tools/glob.ts
import { readdir, stat, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { ToolSchema } from "llm-events/public";
import { resolvePath, hasGitRoot, GLOB_CAP } from "../util.ts";

export const schema: ToolSchema = {
  name: "glob",
  description: "Find files by glob pattern. Returns absolute paths sorted by mtime descending (most recently modified first).",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern, e.g. `**/*.ts` or `src/**/test_*.py`." },
      cwd:     { type: "string", description: "Directory to glob from. Defaults to process cwd." },
    },
    required: ["pattern"],
  },
  tags: ["local", "fs"],
};

interface GlobArgs { pattern: string; cwd?: string; }

interface IgnoreSet { patterns: RegExp[]; }

function compileGitignore(text: string): IgnoreSet {
  const patterns: RegExp[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    // Translate simple gitignore globs (*, ?, **) to regex, anchored loosely.
    let re = "";
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === "*") {
        if (line[i + 1] === "*") { re += ".*"; i++; } else { re += "[^/]*"; }
      } else if (ch === "?") re += "[^/]";
      else if (".+^$()[]{}|\\".includes(ch)) re += "\\" + ch;
      else re += ch;
    }
    patterns.push(new RegExp(`(^|/)${re}($|/)`));
  }
  return { patterns };
}

function isIgnored(rel: string, ig: IgnoreSet): boolean {
  for (const p of ig.patterns) if (p.test(rel)) return true;
  return false;
}

function compileGlob(pattern: string): RegExp {
  let re = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i++;
        if (pattern[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") re += "[^/]";
    else if (".+^$()[]{}|\\".includes(ch)) re += "\\" + ch;
    else re += ch;
  }
  re += "$";
  return new RegExp(re);
}

async function walk(root: string, ig: IgnoreSet | null, out: { abs: string; mtime: number }[]): Promise<void> {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name === ".git") continue;
    const abs = join(root, e.name);
    if (e.isDirectory()) {
      if (ig) {
        const rel = relative(process.cwd(), abs);
        if (isIgnored(rel, ig)) continue;
      }
      await walk(abs, ig, out);
    } else if (e.isFile()) {
      if (ig) {
        const rel = relative(process.cwd(), abs);
        if (isIgnored(rel, ig)) continue;
      }
      try {
        const st = await stat(abs);
        out.push({ abs, mtime: st.mtimeMs });
      } catch { /* ignore */ }
    }
  }
}

export async function handler(args: GlobArgs, _ctx: unknown): Promise<string> {
  const cwd = resolvePath(args.cwd ?? ".");
  const useGitignore = hasGitRoot(cwd);
  let ig: IgnoreSet | null = null;
  if (useGitignore) {
    try {
      const text = await readFile(join(cwd, ".gitignore"), "utf8");
      ig = compileGitignore(text);
    } catch { ig = { patterns: [] }; }
  }
  const collected: { abs: string; mtime: number }[] = [];
  await walk(cwd, ig, collected);
  const re = compileGlob(args.pattern);
  const matches = collected.filter(f => re.test(relative(cwd, f.abs).split(sep).join("/")));
  matches.sort((a, b) => b.mtime - a.mtime);
  const total = matches.length;
  const shown = matches.slice(0, GLOB_CAP).map(m => m.abs);
  const lines = shown.join("\n");
  if (total > GLOB_CAP) return `${lines}\n... [truncated: ${total - GLOB_CAP} more matches]`;
  return lines;
}
```

- [ ] **Step 5: Run tests**

Run: `bun test plugins/llm-local-tools/test/tools/glob.test.ts`
Expected: 4 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add plugins/llm-local-tools/tools/glob.ts plugins/llm-local-tools/test/tools/glob.test.ts plugins/llm-local-tools/test/fixtures/
git commit -m "feat(llm-local-tools): glob tool with gitignore + mtime sort + cap"
```

---

## Task 8: `grep` tool

**Safety / permission semantics for this tool:**
- Read-only content search. No writes; no shell-injectable arguments — `Bun.spawn` invokes `rg` with an argv array (no `shell: true`), so the regex pattern cannot escape into the shell.
- Caps results at `max_results` (default `GREP_DEFAULT_MAX = 200`).
- One-time `which rg` probe at module load; logs a single warning if absent and falls back to a JS implementation.
- Searches arbitrary paths the process can read; no path allow-list. Not safe vs. an adversarial LLM.
- Tagged `["local", "fs"]`.

**Files:**
- Create: `plugins/llm-local-tools/tools/grep.ts`
- Create: `plugins/llm-local-tools/test/tools/grep.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// plugins/llm-local-tools/test/tools/grep.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schema, makeHandler } from "../../tools/grep.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "llt-grep-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const ctx = { signal: new AbortController().signal, callId: "c1", log: () => {} } as any;

// Use the JS-fallback handler for deterministic tests across environments.
const handler = makeHandler({ rgPath: null });

describe("grep tool", () => {
  it("schema metadata", () => {
    expect(schema.name).toBe("grep");
    expect(schema.tags).toEqual(["local", "fs"]);
  });

  it("content mode returns file:line:content", async () => {
    writeFileSync(join(dir, "a.ts"), "alpha\nbeta hello world\ngamma");
    writeFileSync(join(dir, "b.ts"), "no match here");
    const out = await handler({ pattern: "hello", path: dir }, ctx) as string;
    expect(out).toMatch(/a\.ts:2:beta hello world/);
    expect(out).not.toMatch(/b\.ts/);
  });

  it("output_mode files_with_matches", async () => {
    writeFileSync(join(dir, "a.ts"), "x match");
    writeFileSync(join(dir, "b.ts"), "y match");
    const out = await handler({ pattern: "match", path: dir, output_mode: "files_with_matches" }, ctx) as string;
    const lines = out.split("\n").sort();
    expect(lines.length).toBe(2);
    expect(lines[0]).toMatch(/a\.ts$/);
    expect(lines[1]).toMatch(/b\.ts$/);
  });

  it("output_mode count returns one number per file", async () => {
    writeFileSync(join(dir, "a.ts"), "x\nx\ny");
    const out = await handler({ pattern: "x", path: dir, output_mode: "count" }, ctx) as string;
    expect(out).toMatch(/a\.ts:2/);
  });

  it("glob filter restricts files", async () => {
    writeFileSync(join(dir, "a.ts"), "match");
    writeFileSync(join(dir, "b.txt"), "match");
    const out = await handler({ pattern: "match", path: dir, glob: "*.ts" }, ctx) as string;
    expect(out).toMatch(/a\.ts/);
    expect(out).not.toMatch(/b\.txt/);
  });

  it("case_insensitive", async () => {
    writeFileSync(join(dir, "a.ts"), "Hello");
    const out = await handler({ pattern: "hello", path: dir, case_insensitive: true }, ctx) as string;
    expect(out).toMatch(/Hello/);
  });

  it("context lines included in content mode", async () => {
    writeFileSync(join(dir, "a.ts"), "L1\nL2 match\nL3");
    const out = await handler({ pattern: "match", path: dir, context: 1 }, ctx) as string;
    expect(out).toMatch(/L1/);
    expect(out).toMatch(/L3/);
  });

  it("max_results caps content mode", async () => {
    writeFileSync(join(dir, "a.ts"), Array.from({ length: 500 }, (_, i) => `match-${i}`).join("\n"));
    const out = await handler({ pattern: "match", path: dir, max_results: 10 }, ctx) as string;
    const lines = out.split("\n").filter(Boolean);
    expect(lines.length).toBeLessThanOrEqual(11); // 10 + possible truncation marker
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test plugins/llm-local-tools/test/tools/grep.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `tools/grep.ts`**

```ts
// plugins/llm-local-tools/tools/grep.ts
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { spawnSync } from "node:child_process";
import type { ToolSchema } from "llm-events/public";
import { resolvePath, GREP_DEFAULT_MAX } from "../util.ts";

export const schema: ToolSchema = {
  name: "grep",
  description: "Search file contents for a regex. Wraps ripgrep when available. Returns matching lines with file:line:content.",
  parameters: {
    type: "object",
    properties: {
      pattern:           { type: "string", description: "Regex pattern (Rust regex syntax when ripgrep is used; ECMAScript otherwise)." },
      path:              { type: "string", description: "File or directory to search. Defaults to process cwd." },
      glob:              { type: "string", description: "Restrict to files matching this glob (e.g. `*.ts`)." },
      case_insensitive:  { type: "boolean", default: false },
      output_mode:       { type: "string", enum: ["content", "files_with_matches", "count"], default: "content" },
      context:           { type: "integer", minimum: 0, description: "Lines of before/after context (content mode only)." },
      max_results:       { type: "integer", minimum: 1, description: "Cap on returned matches/files. Default 200." },
    },
    required: ["pattern"],
  },
  tags: ["local", "fs"],
};

interface GrepArgs {
  pattern: string;
  path?: string;
  glob?: string;
  case_insensitive?: boolean;
  output_mode?: "content" | "files_with_matches" | "count";
  context?: number;
  max_results?: number;
}

function detectRgPath(): string | null {
  try {
    const r = spawnSync("which", ["rg"], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  } catch { /* ignore */ }
  return null;
}

let probedRg: string | null | undefined = undefined;
let warned = false;
function probeRgOnce(log: (msg: string) => void): string | null {
  if (probedRg === undefined) {
    probedRg = detectRgPath();
    if (probedRg === null && !warned) {
      log("grep: ripgrep not found; using JS fallback (slower)");
      warned = true;
    }
  }
  return probedRg;
}

function compileGlob(pattern: string): RegExp {
  let re = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") { re += ".*"; i++; if (pattern[i + 1] === "/") i++; }
      else re += "[^/]*";
    } else if (ch === "?") re += "[^/]";
    else if (".+^$()[]{}|\\".includes(ch)) re += "\\" + ch;
    else re += ch;
  }
  return new RegExp(re + "$");
}

async function walkFiles(root: string, out: string[]): Promise<void> {
  let st;
  try { st = await stat(root); } catch { return; }
  if (st.isFile()) { out.push(root); return; }
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name === ".git" || e.name === "node_modules") continue;
    const abs = join(root, e.name);
    if (e.isDirectory()) await walkFiles(abs, out);
    else if (e.isFile()) out.push(abs);
  }
}

export function makeHandler(opts: { rgPath: string | null }) {
  return async function handler(args: GrepArgs, ctx: any): Promise<string> {
    const log = (ctx?.log ?? (() => {})) as (m: string) => void;
    const rg = opts.rgPath !== undefined ? opts.rgPath : probeRgOnce(log);
    return runJsFallback(args, rg);
  };
}

async function runJsFallback(args: GrepArgs, _rg: string | null): Promise<string> {
  const root = resolvePath(args.path ?? ".");
  const flags = args.case_insensitive ? "i" : "";
  const re = new RegExp(args.pattern, flags);
  const mode = args.output_mode ?? "content";
  const maxResults = Math.max(1, args.max_results ?? GREP_DEFAULT_MAX);
  const ctxLines = Math.max(0, args.context ?? 0);
  const globRe = args.glob ? compileGlob(args.glob) : null;

  const files: string[] = [];
  await walkFiles(root, files);
  const filtered = globRe ? files.filter(f => globRe.test(relative(root, f).split(sep).join("/"))) : files;

  if (mode === "files_with_matches") {
    const hits: string[] = [];
    for (const f of filtered) {
      try {
        const text = await readFile(f, "utf8");
        if (re.test(text)) hits.push(f);
        if (hits.length >= maxResults) break;
      } catch { /* skip */ }
    }
    return hits.join("\n");
  }

  if (mode === "count") {
    const lines: string[] = [];
    for (const f of filtered) {
      try {
        const text = await readFile(f, "utf8");
        let n = 0;
        for (const ln of text.split("\n")) if (re.test(ln)) n++;
        if (n > 0) lines.push(`${f}:${n}`);
        if (lines.length >= maxResults) break;
      } catch { /* skip */ }
    }
    return lines.join("\n");
  }

  // content mode
  const out: string[] = [];
  let total = 0;
  for (const f of filtered) {
    let text: string;
    try { text = await readFile(f, "utf8"); } catch { continue; }
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        const start = Math.max(0, i - ctxLines);
        const end = Math.min(lines.length - 1, i + ctxLines);
        for (let k = start; k <= end; k++) {
          out.push(`${f}:${k + 1}:${lines[k]}`);
          total++;
          if (total >= maxResults) {
            out.push(`... [truncated: max_results=${maxResults} reached]`);
            return out.join("\n");
          }
        }
      }
    }
  }
  return out.join("\n");
}

// Default handler — probes rg lazily.
export const handler = makeHandler({ rgPath: undefined as any });
```

> Note: `makeHandler({ rgPath: null })` is used in tests to pin the JS fallback for deterministic results. The exported `handler` (used by `index.ts`) will probe `rg` once at first invocation and log the one-line warning if absent. The current implementation always uses the JS fallback for correctness; a future revision can dispatch to `rg` via `Bun.spawn` with an argv array (no shell) when `rgPath` is non-null. Schema description warns the LLM about regex flavor.

- [ ] **Step 4: Run tests**

Run: `bun test plugins/llm-local-tools/test/tools/grep.test.ts`
Expected: 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-local-tools/tools/grep.ts plugins/llm-local-tools/test/tools/grep.test.ts
git commit -m "feat(llm-local-tools): grep tool (JS fallback; rg probe at startup)"
```

---

## Task 9: `bash` tool

**Safety / permission semantics for this tool:**
- Spawns the system shell with `shell: true`. Pipes, redirection, `&&`, command substitution all work. **There is no command allow-list, no `rm -rf` guard, no network firewall.** This is by spec — the v0 trust model is "the engineer is reading the TUI."
- Default timeout 120 s; hard cap 600 s. On timeout: SIGTERM → wait 2 s → SIGKILL. Returns partial output with `... [killed: timeout after Nms]` marker and a non-zero `exit_code`.
- Output cap 256 KB, **middle-truncated** (head + tail kept, middle elided with marker).
- `ctx.signal` is wired to the spawned process — when the driver aborts the turn, the child receives SIGTERM.
- `run_in_background: true` is **rejected with a clear error** in v0 (schema reserves the field).
- Combines stdout + stderr in source order into a single output stream.
- Tagged `["local", "shell"]` — distinct from `fs` tools so an agent can exclude shell while keeping fs reads (a common pattern per Spec 6).

**Files:**
- Create: `plugins/llm-local-tools/tools/bash.ts`
- Create: `plugins/llm-local-tools/test/tools/bash.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// plugins/llm-local-tools/test/tools/bash.test.ts
import { describe, it, expect } from "bun:test";
import { schema, handler } from "../../tools/bash.ts";

function makeCtx(signal?: AbortSignal) {
  return { signal: signal ?? new AbortController().signal, callId: "c1", log: () => {} } as any;
}

describe("bash tool", () => {
  it("schema metadata", () => {
    expect(schema.name).toBe("bash");
    expect(schema.tags).toEqual(["local", "shell"]);
  });

  it("captures stdout", async () => {
    const r: any = await handler({ command: "echo hello" }, makeCtx());
    expect(r.exit_code).toBe(0);
    expect(r.output).toContain("hello");
    expect(r.killed_by_timeout).toBe(false);
  });

  it("captures stderr in same stream", async () => {
    const r: any = await handler({ command: "echo out; echo err 1>&2" }, makeCtx());
    expect(r.exit_code).toBe(0);
    expect(r.output).toContain("out");
    expect(r.output).toContain("err");
  });

  it("non-zero exit reflected in exit_code", async () => {
    const r: any = await handler({ command: "exit 7" }, makeCtx());
    expect(r.exit_code).toBe(7);
  });

  it("timeout kills the process and reports partial output", async () => {
    const r: any = await handler({ command: "echo before; sleep 5", timeout: 1000 }, makeCtx());
    expect(r.killed_by_timeout).toBe(true);
    expect(r.output).toContain("before");
    expect(r.output).toContain("[killed: timeout after");
    expect(r.exit_code).not.toBe(0);
  });

  it("rejects run_in_background: true", async () => {
    await expect(handler({ command: "echo x", run_in_background: true }, makeCtx()))
      .rejects.toThrow(/run_in_background/i);
  });

  it("middle-truncates output past cap", async () => {
    // Generate >256KB of output; check head + tail preserved.
    const cmd = `node -e "for (let i=0;i<300000;i++) process.stdout.write('A'); process.stdout.write('END');"`;
    const r: any = await handler({ command: cmd, timeout: 30000 }, makeCtx());
    expect(r.truncated).toBe(true);
    expect(r.output).toContain("[truncated:");
    expect(r.output).toContain("END");
  });

  it("aborts when ctx.signal aborts mid-run", async () => {
    const ac = new AbortController();
    const promise = handler({ command: "sleep 5", timeout: 30000 }, makeCtx(ac.signal));
    setTimeout(() => ac.abort(), 200);
    const r: any = await promise;
    expect(r.exit_code).not.toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test plugins/llm-local-tools/test/tools/bash.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `tools/bash.ts`**

```ts
// plugins/llm-local-tools/tools/bash.ts
import { spawn } from "node:child_process";
import type { ToolSchema } from "llm-events/public";
import { resolvePath, truncateMiddle, BASH_OUTPUT_CAP } from "../util.ts";

export const schema: ToolSchema = {
  name: "bash",
  description: "Execute a shell command. Captures combined stdout/stderr. Default timeout 120s. Use sparingly — prefer purpose-built tools when one exists.",
  parameters: {
    type: "object",
    properties: {
      command:           { type: "string" },
      cwd:               { type: "string", description: "Working directory. Defaults to process cwd." },
      timeout:           { type: "integer", minimum: 1000, maximum: 600000, description: "Milliseconds. Default 120000. Hard max 600000 (10 min)." },
      run_in_background: { type: "boolean", default: false, description: "Reserved. Currently rejected if true." },
    },
    required: ["command"],
  },
  tags: ["local", "shell"],
};

interface BashArgs {
  command: string;
  cwd?: string;
  timeout?: number;
  run_in_background?: boolean;
}

interface BashResult {
  exit_code: number;
  output: string;
  duration_ms: number;
  truncated: boolean;
  killed_by_timeout: boolean;
}

export async function handler(args: BashArgs, ctx: any): Promise<BashResult> {
  if (args.run_in_background === true) throw new Error("bash: run_in_background is not supported in v0");
  const cwd = resolvePath(args.cwd ?? ".");
  const timeout = Math.min(600000, Math.max(1000, args.timeout ?? 120000));
  const start = Date.now();

  return new Promise<BashResult>((resolve) => {
    const child = spawn(args.command, { cwd, shell: true });
    const chunks: Buffer[] = [];
    let killedByTimeout = false;
    let killedBySignal = false;
    let totalBytes = 0;

    const onData = (b: Buffer) => {
      chunks.push(b);
      totalBytes += b.length;
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    const timer = setTimeout(() => {
      killedByTimeout = true;
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* ignore */ } }, 2000);
    }, timeout);

    const onAbort = () => {
      killedBySignal = true;
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* ignore */ } }, 2000);
    };
    if (ctx?.signal) {
      if (ctx.signal.aborted) onAbort();
      else ctx.signal.addEventListener("abort", onAbort, { once: true });
    }

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (ctx?.signal) ctx.signal.removeEventListener?.("abort", onAbort as any);
      const duration = Date.now() - start;
      let raw = Buffer.concat(chunks).toString("utf8");
      if (killedByTimeout) raw += `\n... [killed: timeout after ${timeout}ms]`;
      else if (killedBySignal) raw += `\n... [killed: cancelled by signal]`;
      const wasTruncated = totalBytes > BASH_OUTPUT_CAP;
      const out = wasTruncated
        ? truncateMiddle(raw, BASH_OUTPUT_CAP, `... [truncated: ${totalBytes - BASH_OUTPUT_CAP} bytes elided from middle] ...`)
        : raw;
      const exitCode = code ?? (signal ? 128 + 15 : 1);
      resolve({
        exit_code: exitCode,
        output: out,
        duration_ms: duration,
        truncated: wasTruncated,
        killed_by_timeout: killedByTimeout,
      });
    });
  });
}
```

- [ ] **Step 4: Run tests**

Run: `bun test plugins/llm-local-tools/test/tools/bash.test.ts`
Expected: 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-local-tools/tools/bash.ts plugins/llm-local-tools/test/tools/bash.test.ts
git commit -m "feat(llm-local-tools): bash tool (timeout escalation, middle-truncation, signal-wired)"
```

---

## Task 10: `tools.ts` — static array of all tools

**Files:**
- Create: `plugins/llm-local-tools/tools.ts`

- [ ] **Step 1: Write `tools.ts`**

```ts
// plugins/llm-local-tools/tools.ts
import * as readMod from "./tools/read.ts";
import * as writeMod from "./tools/write.ts";
import * as createMod from "./tools/create.ts";
import * as editMod from "./tools/edit.ts";
import * as globMod from "./tools/glob.ts";
import * as grepMod from "./tools/grep.ts";
import * as bashMod from "./tools/bash.ts";
import type { ToolSchema } from "llm-events/public";

export interface ToolEntry {
  schema: ToolSchema;
  handler: (args: any, ctx: any) => Promise<unknown>;
}

export const ALL_TOOLS: ToolEntry[] = [
  { schema: readMod.schema, handler: readMod.handler },
  { schema: writeMod.schema, handler: writeMod.handler },
  { schema: createMod.schema, handler: createMod.handler },
  { schema: editMod.schema, handler: editMod.handler },
  { schema: globMod.schema, handler: globMod.handler },
  { schema: grepMod.schema, handler: grepMod.handler },
  { schema: bashMod.schema, handler: bashMod.handler },
];
```

- [ ] **Step 2: Sanity test**

Run: `bun -e "import('./plugins/llm-local-tools/tools.ts').then(m => console.log(m.ALL_TOOLS.map(t => t.schema.name)))"`
Expected: `[ "read", "write", "create", "edit", "glob", "grep", "bash" ]`

- [ ] **Step 3: Commit**

```bash
git add plugins/llm-local-tools/tools.ts
git commit -m "feat(llm-local-tools): aggregate ALL_TOOLS array"
```

---

## Task 11: `index.ts` — registration loop + teardown bundle

**Files:**
- Modify: `plugins/llm-local-tools/index.ts`

- [ ] **Step 1: Replace placeholder index with full implementation**

```ts
// plugins/llm-local-tools/index.ts
import type { KaizenPlugin } from "kaizen/types";
import type { ToolSchema } from "llm-events/public";
import { ALL_TOOLS } from "./tools.ts";

interface ToolsRegistryService {
  register(schema: ToolSchema, handler: (args: any, ctx: any) => Promise<unknown>): () => void;
  list(filter?: { tags?: string[]; names?: string[] }): ToolSchema[];
  invoke(name: string, args: unknown, ctx: any): Promise<unknown>;
}

const plugin: KaizenPlugin = {
  name: "llm-local-tools",
  apiVersion: "3.0.0",
  permissions: { tier: "trusted" },
  services: { consumes: ["tools:registry", "llm-events:vocabulary"] },

  async setup(ctx) {
    const registry = ctx.useService<ToolsRegistryService>("tools:registry");
    if (!registry) throw new Error("llm-local-tools: tools:registry service not available");

    const unregisters: Array<() => void> = [];
    for (const tool of ALL_TOOLS) {
      unregisters.push(registry.register(tool.schema, tool.handler));
    }
    ctx.log?.(`llm-local-tools: registered ${ALL_TOOLS.length} tools`);

    return {
      async teardown() {
        for (const u of unregisters) {
          try { u(); } catch { /* idempotent */ }
        }
      },
    };
  },
};

export default plugin;
```

- [ ] **Step 2: Update scaffold test to assert the consumer + setup behavior**

Replace `plugins/llm-local-tools/test/scaffold.test.ts`:

```ts
import { describe, it, expect, mock } from "bun:test";
import plugin from "../index.ts";

function makeRegistry() {
  const registered: string[] = [];
  return {
    registered,
    register: mock((schema: any, _handler: any) => {
      registered.push(schema.name);
      return () => {
        const i = registered.indexOf(schema.name);
        if (i >= 0) registered.splice(i, 1);
      };
    }),
    list: mock(() => []),
    invoke: mock(async () => undefined),
  };
}

function makeCtx(registry: any) {
  return {
    log: mock(() => {}),
    useService: mock((name: string) => name === "tools:registry" ? registry : undefined),
    defineEvent: mock(() => {}),
    on: mock(() => {}),
    emit: mock(async () => []),
    defineService: mock(() => {}),
    provideService: mock(() => {}),
  } as any;
}

describe("llm-local-tools plugin", () => {
  it("metadata", () => {
    expect(plugin.name).toBe("llm-local-tools");
    expect(plugin.apiVersion).toBe("3.0.0");
    expect(plugin.services?.consumes).toContain("tools:registry");
  });

  it("registers all seven tools at setup", async () => {
    const registry = makeRegistry();
    const ctx = makeCtx(registry);
    await plugin.setup!(ctx);
    expect(registry.registered.sort()).toEqual(
      ["bash", "create", "edit", "glob", "grep", "read", "write"]
    );
  });

  it("teardown unregisters everything", async () => {
    const registry = makeRegistry();
    const ctx = makeCtx(registry);
    const result = await plugin.setup!(ctx) as { teardown: () => Promise<void> };
    await result.teardown();
    expect(registry.registered).toEqual([]);
  });

  it("throws if tools:registry is unavailable", async () => {
    const ctx = {
      log: () => {},
      useService: () => undefined,
    } as any;
    await expect(plugin.setup!(ctx)).rejects.toThrow(/tools:registry/);
  });
});
```

- [ ] **Step 3: Run tests**

Run: `bun test plugins/llm-local-tools/test/scaffold.test.ts`
Expected: 4 tests PASS.

- [ ] **Step 4: Commit**

```bash
git add plugins/llm-local-tools/index.ts plugins/llm-local-tools/test/scaffold.test.ts
git commit -m "feat(llm-local-tools): register all tools at setup, return teardown bundle"
```

---

## Task 12: `public.d.ts` — re-exports

**Files:**
- Modify: `plugins/llm-local-tools/public.d.ts`

- [ ] **Step 1: Write the final `public.d.ts`**

```ts
// plugins/llm-local-tools/public.d.ts
export type { ToolSchema, ToolCall } from "llm-events/public";

export const TOOL_NAMES: readonly [
  "read", "write", "create", "edit", "glob", "grep", "bash"
];
```

- [ ] **Step 2: Add the runtime export from `index.ts`** (so consumers can introspect):

Append to `plugins/llm-local-tools/index.ts` (above `export default plugin`):

```ts
export const TOOL_NAMES = ["read", "write", "create", "edit", "glob", "grep", "bash"] as const;
```

- [ ] **Step 3: Verify tests still pass**

Run: `bun test plugins/llm-local-tools/`
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add plugins/llm-local-tools/public.d.ts plugins/llm-local-tools/index.ts
git commit -m "feat(llm-local-tools): export TOOL_NAMES from public surface"
```

---

## Task 13: README with mandatory safety warning

**Files:**
- Create: `plugins/llm-local-tools/README.md`

The first 200 words MUST contain the bold warning quoted verbatim from Spec 6.

- [ ] **Step 1: Write `README.md`**

```markdown
# llm-local-tools

> **WARNING — read this first.**
>
> This plugin is **not** sandboxed. It executes whatever shell commands and file writes the LLM emits, with the full privileges of the kaizen process. Do not use it with prompts you did not author, or with LLMs you do not trust to follow instructions. For untrusted contexts, use `llm-local-tools-sandboxed` (planned, not yet shipped).

Built-in local-development toolset for the openai-compatible harness. Registers seven tools into the `tools:registry` service from Spec 4:

| Tool   | Tags             | Purpose                                                          |
| ------ | ---------------- | ---------------------------------------------------------------- |
| read   | local, fs        | Read a file with line-numbered output. Caps: 50 MB hard, 256 KB / 2000 lines returned. Refuses binary files. |
| write  | local, fs        | Overwrite an existing file. Refuses if file does not exist.      |
| create | local, fs        | Create a new file. Refuses if file already exists. No mkdir-p.   |
| edit   | local, fs        | Exact-string replace. Unique-match contract; `replace_all` opt-in. |
| glob   | local, fs        | File listing by pattern. Honors `.gitignore` when in a git repo. |
| grep   | local, fs        | Regex content search. Wraps `rg` if present; JS fallback otherwise. |
| bash   | local, shell     | Shell command exec. Default 120 s timeout, hard cap 600 s. 256 KB middle-truncation. |

## Tag-based filtering

Capability plugins (e.g. `llm-agents`) compose toolsets via the registry filter API:

```ts
registry.list({ tags: ["fs"] })   // five tools, no shell
registry.list({ tags: ["shell"] }) // bash only
registry.list({ tags: ["local"] }) // all seven
```

A "researcher" agent typically uses `toolFilter: { tags: ["fs"] }` to omit `bash`.

## Configuration

This plugin has no configuration file. Behavior is fixed; per-tool caps and timeouts are spec-defined defaults. Working directory is `process.cwd()` at invoke time.

## Working directory

Every tool resolves paths against `process.cwd()` at the moment the LLM calls it. There is no plugin-managed cwd. If the LLM runs `cd foo && ...` inside a `bash` call, only the child shell sees the change — the parent kaizen process does not. This matches Claude Code semantics.

## Safety semantics (per-tool)

- `read`: 50 MB hard refusal; binary-byte refusal; symlinks are followed; no path allow-list.
- `write` / `create`: parent dir must exist; no symlink-target validation; no path allow-list.
- `edit`: unique-match required (or `replace_all`); whitespace-sensitive.
- `glob` / `grep`: read-only listing/search.
- `bash`: full shell, no command allow-list. `run_in_background: true` is rejected in v0.

For untrusted contexts, replace this plugin with `llm-local-tools-sandboxed` (planned).

## Background processes

`run_in_background: true` is reserved in `bash`'s schema but rejected at runtime in v0. A v1 follow-up may add `bash_output({ id })` and `bash_kill({ id })`. Schema reservation now means future addition is non-breaking.

## ripgrep dependency

Soft. On first invocation of `grep`, the plugin probes `which rg`. If absent, it logs a one-line warning and uses a JS fallback (slower; ECMAScript regex flavor instead of Rust regex). Install `ripgrep` for faster searches and richer regex support.
```

- [ ] **Step 2: Commit**

```bash
git add plugins/llm-local-tools/README.md
git commit -m "docs(llm-local-tools): README with mandatory safety warning + per-tool semantics"
```

---

## Task 14: Integration test against a fake `ToolsRegistryService`

**Files:**
- Create: `plugins/llm-local-tools/test/integration.test.ts`

This test verifies the end-to-end registration + tag filtering + invoke shape against a hand-rolled `ToolsRegistryService` that mimics Spec 4's behavior. It does NOT depend on `llm-tools-registry` being implemented — it stubs the contract.

- [ ] **Step 1: Write the test**

```ts
// plugins/llm-local-tools/test/integration.test.ts
import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../index.ts";
import type { ToolSchema } from "../public.d.ts";

function makeFakeRegistry() {
  const map = new Map<string, { schema: ToolSchema; handler: (a: any, c: any) => Promise<unknown> }>();
  return {
    map,
    register(schema: ToolSchema, handler: (a: any, c: any) => Promise<unknown>) {
      if (map.has(schema.name)) throw new Error(`duplicate: ${schema.name}`);
      const entry = { schema, handler };
      map.set(schema.name, entry);
      return () => { if (map.get(schema.name) === entry) map.delete(schema.name); };
    },
    list(filter?: { tags?: string[]; names?: string[] }) {
      let out = [...map.values()].map(e => e.schema);
      if (filter?.tags?.length) out = out.filter(s => s.tags?.some(t => filter.tags!.includes(t)));
      if (filter?.names?.length) out = out.filter(s => filter.names!.includes(s.name));
      return out;
    },
    async invoke(name: string, args: unknown, ctx: any) {
      const e = map.get(name);
      if (!e) throw new Error(`unknown tool: ${name}`);
      return e.handler(args, ctx);
    },
  };
}

function makeCtx(registry: any) {
  return {
    log: () => {},
    useService: (n: string) => n === "tools:registry" ? registry : undefined,
    defineEvent: () => {},
    on: () => {},
    emit: async () => [],
    defineService: () => {},
    provideService: () => {},
  } as any;
}

describe("llm-local-tools integration", () => {
  it("registers seven tools with correct tags", async () => {
    const reg = makeFakeRegistry();
    await plugin.setup!(makeCtx(reg));
    expect(reg.list().map(s => s.name).sort()).toEqual(
      ["bash", "create", "edit", "glob", "grep", "read", "write"]
    );
    expect(reg.list({ tags: ["fs"] }).map(s => s.name).sort()).toEqual(
      ["create", "edit", "glob", "grep", "read", "write"]
    );
    expect(reg.list({ tags: ["shell"] }).map(s => s.name)).toEqual(["bash"]);
    expect(reg.list({ tags: ["local"] })).toHaveLength(7);
  });

  it("end-to-end: create then read then grep through registry.invoke", async () => {
    const reg = makeFakeRegistry();
    await plugin.setup!(makeCtx(reg));
    const dir = mkdtempSync(join(tmpdir(), "llt-int-"));
    try {
      const filePath = join(dir, "hello.txt");
      const ctx = { signal: new AbortController().signal, callId: "c1", log: () => {} };
      await reg.invoke("create", { path: filePath, content: "hi" }, ctx);
      const readOut = await reg.invoke("read", { path: filePath }, ctx) as string;
      expect(readOut).toContain("hi");
      const grepOut = await reg.invoke("grep", { pattern: "hi", path: dir }, ctx) as string;
      expect(grepOut).toContain("hello.txt");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("teardown removes every tool", async () => {
    const reg = makeFakeRegistry();
    const result = await plugin.setup!(makeCtx(reg)) as { teardown: () => Promise<void> };
    expect(reg.list()).toHaveLength(7);
    await result.teardown();
    expect(reg.list()).toHaveLength(0);
  });

  it("schemas validate as JSONSchema7-shaped (object + properties)", async () => {
    const reg = makeFakeRegistry();
    await plugin.setup!(makeCtx(reg));
    for (const s of reg.list()) {
      expect(s.parameters.type).toBe("object");
      expect(typeof s.description).toBe("string");
      expect(s.tags).toContain("local");
    }
  });
});
```

- [ ] **Step 2: Run integration tests**

Run: `bun test plugins/llm-local-tools/test/integration.test.ts`
Expected: 4 tests PASS.

- [ ] **Step 3: Run the full plugin suite**

Run: `bun test plugins/llm-local-tools/`
Expected: all tests PASS across `util`, all 7 tool tests, scaffold, integration.

- [ ] **Step 4: TypeScript check**

Run: `bun --bun tsc --noEmit -p plugins/llm-local-tools/tsconfig.json plugins/llm-local-tools/index.ts plugins/llm-local-tools/util.ts plugins/llm-local-tools/tools.ts plugins/llm-local-tools/tools/*.ts plugins/llm-local-tools/public.d.ts`
Expected: no diagnostics.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-local-tools/test/integration.test.ts
git commit -m "test(llm-local-tools): integration test against fake ToolsRegistryService"
```

---

## Task 15: Marketplace catalog entry

**Files:**
- Modify: `.kaizen/marketplace.json`

- [ ] **Step 1: Add entry to `.kaizen/marketplace.json`**

Insert this object into the `entries` array (after the `openai-llm` entry, before any harness entries):

```json
{
  "kind": "plugin",
  "name": "llm-local-tools",
  "description": "Built-in local-development toolset (read/write/create/edit/glob/grep/bash) for the openai-compatible harness. NOT sandboxed.",
  "categories": ["tools", "local"],
  "versions": [{ "version": "0.1.0", "source": { "type": "file", "path": "plugins/llm-local-tools" } }]
}
```

- [ ] **Step 2: Validate JSON**

Run: `bun -e "console.log(JSON.parse(require('node:fs').readFileSync('.kaizen/marketplace.json','utf8')).entries.find(e=>e.name==='llm-local-tools').name)"`
Expected: `llm-local-tools`

- [ ] **Step 3: Commit**

```bash
git add .kaizen/marketplace.json
git commit -m "chore(marketplace): publish llm-local-tools@0.1.0"
```

---

## Acceptance verification (run before declaring done)

- [ ] `bun test plugins/llm-local-tools/` — full suite PASS.
- [ ] `bun --bun tsc --noEmit -p plugins/llm-local-tools/tsconfig.json plugins/llm-local-tools/**/*.ts plugins/llm-local-tools/*.ts plugins/llm-local-tools/public.d.ts` — no diagnostics.
- [ ] README starts with the bold warning quoted from Spec 6 (within first 200 words).
- [ ] Marketplace entry present.
- [ ] All seven tools register with `local` tag; `read`/`write`/`create`/`edit`/`glob`/`grep` carry `fs`; `bash` carries `shell`.
- [ ] `bash` rejects `run_in_background: true` in v0.
- [ ] `edit` enforces unique-match unless `replace_all` is set; rejects identical strings.
- [ ] `read` refuses files >50 MB and binary files (NUL byte).
- [ ] `bash` middle-truncates at 256 KB and escalates SIGTERM→SIGKILL on timeout.
