# llm-axioms Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `llm-axioms` plugin — a session-scoped Aristotelean axiom workspace plus a static "when to derive first principles" methodology section in the system prompt, with three model-facing tools (`axiom_record` / `axiom_amend` / `axiom_drop`) and three user slash commands (`/axioms:list` / `/axioms:show` / `/axioms:clear`).

**Architecture:** New plugin `plugins/llm-axioms/` providing the `axioms:registry` contract added to `llm-contracts`. Per-session JSON persistence under `~/.kaizen/plugins/llm-axioms/sessions/<id>.json` with atomic writes. Two `prompt:registry` sections (static methodology at priority 50; dynamic workspace at priority 180). Topo-hint optional deps on `config:store`, `prompt:registry`, `tools:registry`, `slash:registry`. Lifecycle subscribes to `session:active-changed` to swap the active session's axioms.

**Tech Stack:** Bun + TypeScript (workspace dep), kaizen runtime (`KaizenPlugin` from `kaizen/types`), contracts from `llm-contracts/public`, tests with `bun:test`.

**Source spec:** `docs/superpowers/specs/2026-05-19-llm-axioms-design.md`

---

## File Structure Overview

**Modified in `plugins/llm-contracts/`:**
- `contracts/axioms-registry.ts` (new) — contract definition.
- `public.ts` — add `AxiomEntry` and `AxiomsRegistryService` re-exports.
- `index.ts` — add `defineService` call.
- `package.json` — bump version `0.2.0` → `0.3.0`.

**New plugin `plugins/llm-axioms/`:**
- `package.json` — workspace manifest, version `0.1.0`.
- `tsconfig.json` — matches `plugins/llm-system-prompt/tsconfig.json`.
- `README.md` — user-facing contract.
- `CLAUDE.md` — internal agent notes.
- `public.d.ts` — re-exports + plugin-internal types.
- `schema.ts` — `validateAxiomId`, `validateAxiomEntry`. Pure.
- `paths.ts` — `resolveAxiomsDir`, `ensureDir`, `sessionFilePath`, `sweepStaleTempFiles`. Touches FS, no kaizen.
- `config.ts` — `DEFAULT_CONFIG` + `CONFIG_SCHEMA`. Pure.
- `methodology.ts` — `METHODOLOGY_TEXT` constant + `renderMethodology()`. Pure.
- `injection.ts` — `buildWorkspaceBlock`. Pure.
- `store.ts` — `makeStore` (in-memory + disk; atomic writes via tmp+rename). Touches FS.
- `tools.ts` — `registerTools` (three tool registrations). Pure factory.
- `slash.ts` — `makeSlashHandlers` (three slash commands). Pure factory.
- `index.ts` — plugin lifecycle; the only file that touches `ctx`.
- `test/schema.test.ts`, `test/paths.test.ts`, `test/injection.test.ts`, `test/methodology.test.ts`, `test/store.test.ts`, `test/tools.test.ts`, `test/slash.test.ts`, `test/config.test.ts`, `test/index.test.ts`.

**Modified in repo root:**
- `.kaizen/marketplace.json` — bump `llm-contracts` to `0.3.0`, add `llm-axioms` entry at `0.1.0`.
- `harnesses/openai-compatible.json` — update `llm-contracts@0.3.0`, add `llm-axioms@0.1.0`.
- `docs/TODO.md` — strike item.

**Module boundaries (mirror llm-memory):**
- `store.ts` is the only module that touches disk.
- Only `index.ts` imports `kaizen/types` or touches `ctx`.
- `schema.ts`, `injection.ts`, `methodology.ts`, `config.ts` are pure.
- `tools.ts`/`slash.ts` are pure factories returning unregister fns.

---

## Task 1: Add `axioms:registry` contract to `llm-contracts`

**Files:**
- Create: `plugins/llm-contracts/contracts/axioms-registry.ts`
- Modify: `plugins/llm-contracts/public.ts`
- Modify: `plugins/llm-contracts/index.ts`
- Modify: `plugins/llm-contracts/package.json`

- [ ] **Step 1: Create the contract module**

Create `plugins/llm-contracts/contracts/axioms-registry.ts`:

```typescript
export interface AxiomEntry {
  /** Slug, `[a-z0-9_-]{1,64}`, model-chosen, stable across amend/drop. */
  id: string;
  /** One sentence, declarative, falsifiable. */
  statement: string;
  /** Supporting truths; may reference other axioms via `[[id]]`. */
  premises: string[];
  /** Why premises imply the statement. */
  reasoning: string;
  /** Applicability within the session. */
  scope: string;
  /** ms epoch, auto-set on record. */
  derivedAt: number;
  /** ms epoch, auto-set on amend. */
  amendedAt?: number;
}

export interface AxiomsRegistryService {
  list(): readonly AxiomEntry[];
  get(id: string): AxiomEntry | null;
  record(entry: Omit<AxiomEntry, "derivedAt" | "amendedAt">): Promise<AxiomEntry>;
  amend(
    id: string,
    patch: Partial<Omit<AxiomEntry, "id" | "derivedAt">>,
  ): Promise<AxiomEntry>;
  drop(id: string, reason: string): Promise<boolean>;
  clear(): Promise<void>;
  onChange(cb: () => void): () => void;
}

export const CONTRACT_ID = "axioms:registry" as const;
export const DESCRIPTION = "Session-scoped Aristotelean axiom workspace.";
```

- [ ] **Step 2: Re-export types from `public.ts`**

Open `plugins/llm-contracts/public.ts` and add (after the existing memory/agents lines, before the dispatch line):

```typescript
export type { AxiomsRegistryService, AxiomEntry } from "./contracts/axioms-registry";
```

- [ ] **Step 3: Wire `defineService` in `index.ts`**

Open `plugins/llm-contracts/index.ts`. Add the import next to the other `import * as`:

```typescript
import * as axiomsRegistryContract from "./contracts/axioms-registry";
```

Then inside `setup(ctx)`, add the line (near the other registry contracts):

```typescript
ctx.defineService(axiomsRegistryContract.CONTRACT_ID, { description: axiomsRegistryContract.DESCRIPTION });
```

- [ ] **Step 4: Bump version in `package.json`**

In `plugins/llm-contracts/package.json`, change:

```json
"version": "0.2.0",
```

to:

```json
"version": "0.3.0",
```

- [ ] **Step 5: Verify the contract module type-checks**

Run: `cd plugins/llm-contracts && bun tsc --noEmit && cd ../..`
Expected: no output, exit 0.

- [ ] **Step 6: Commit**

```bash
git add plugins/llm-contracts/contracts/axioms-registry.ts plugins/llm-contracts/public.ts plugins/llm-contracts/index.ts plugins/llm-contracts/package.json
git commit -m "feat(llm-contracts): add axioms:registry contract"
```

---

## Task 2: Scaffold the `llm-axioms` plugin

**Files:**
- Create: `plugins/llm-axioms/package.json`
- Create: `plugins/llm-axioms/tsconfig.json`
- Create: `plugins/llm-axioms/public.d.ts`
- Create: `plugins/llm-axioms/index.ts` (stub)
- Create: `plugins/llm-axioms/test/.gitkeep`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "llm-axioms",
  "version": "0.1.0",
  "description": "Session-scoped Aristotelean axiom workspace. Provides axioms:registry.",
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
    "@types/json-schema": "^7.0.15",
    "typescript": "^5.4.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

Copy the format from `plugins/llm-system-prompt/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "allowImportingTsExtensions": true,
    "types": ["bun"]
  },
  "include": ["**/*.ts"]
}
```

- [ ] **Step 3: Create `public.d.ts`**

```typescript
// Re-export the cross-plugin contract types from llm-contracts.
export type { AxiomEntry, AxiomsRegistryService } from "llm-contracts/public";

// Plugin-internal config shape. Consumed only by config:store.register and
// the plugin's own setup; never crosses other plugin boundaries.
export interface AxiomsConfig {
  axiomsDir: string;
  injectionByteCap: number;
  methodologyEnabled: boolean;
  workspaceEnabled: boolean;
  staleTempMs: number;
}
```

- [ ] **Step 4: Create `index.ts` stub**

```typescript
import type { KaizenPlugin } from "kaizen/types";

const plugin: KaizenPlugin = {
  name: "llm-axioms",
  apiVersion: "3.0.0",
  permissions: { tier: "unscoped" },
  services: {
    provides: ["axioms:registry"],
    consumes: ["events:vocabulary"],
  },
  async setup(_ctx) {
    // Implementation lands in later tasks.
  },
  async stop() {},
};

export default plugin;
```

- [ ] **Step 5: Create empty test dir**

```bash
mkdir -p plugins/llm-axioms/test
touch plugins/llm-axioms/test/.gitkeep
```

- [ ] **Step 6: Install workspace deps**

Run: `bun install`
Expected: succeeds; `node_modules` linked under `plugins/llm-axioms`.

- [ ] **Step 7: Verify the stub type-checks**

Run: `cd plugins/llm-axioms && bun tsc --noEmit && cd ../..`
Expected: no output, exit 0.

- [ ] **Step 8: Commit**

```bash
git add plugins/llm-axioms/package.json plugins/llm-axioms/tsconfig.json plugins/llm-axioms/public.d.ts plugins/llm-axioms/index.ts plugins/llm-axioms/test/.gitkeep bun.lock
git commit -m "feat(llm-axioms): scaffold plugin (manifest + stub)"
```

---

## Task 3: `schema.ts` — id and entry validation (TDD)

**Files:**
- Create: `plugins/llm-axioms/test/schema.test.ts`
- Create: `plugins/llm-axioms/schema.ts`

- [ ] **Step 1: Write the failing tests**

Create `plugins/llm-axioms/test/schema.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import { validateAxiomId, validateAxiomEntry, AxiomValidationError } from "../schema.ts";

describe("validateAxiomId", () => {
  it("accepts simple lowercase ids", () => {
    expect(() => validateAxiomId("foo")).not.toThrow();
    expect(() => validateAxiomId("world-class-offline")).not.toThrow();
    expect(() => validateAxiomId("a_b_c")).not.toThrow();
    expect(() => validateAxiomId("x1y2z3")).not.toThrow();
  });
  it("rejects empty string", () => {
    expect(() => validateAxiomId("")).toThrow(AxiomValidationError);
  });
  it("rejects strings > 64 chars", () => {
    expect(() => validateAxiomId("a".repeat(65))).toThrow(AxiomValidationError);
  });
  it("rejects uppercase, spaces, dots, slashes", () => {
    expect(() => validateAxiomId("Foo")).toThrow(AxiomValidationError);
    expect(() => validateAxiomId("with space")).toThrow(AxiomValidationError);
    expect(() => validateAxiomId("a.b")).toThrow(AxiomValidationError);
    expect(() => validateAxiomId("a/b")).toThrow(AxiomValidationError);
  });
});

describe("validateAxiomEntry", () => {
  const ok = {
    id: "good",
    statement: "Calendars must work offline.",
    premises: ["users travel", "networks fail"],
    reasoning: "Without offline support a calendar is unusable during travel.",
    scope: "UX baseline",
  };
  it("accepts a well-formed entry", () => {
    expect(() => validateAxiomEntry(ok)).not.toThrow();
  });
  it("rejects empty statement", () => {
    expect(() => validateAxiomEntry({ ...ok, statement: "" })).toThrow(AxiomValidationError);
  });
  it("rejects statement > 280 chars", () => {
    expect(() => validateAxiomEntry({ ...ok, statement: "a".repeat(281) })).toThrow(AxiomValidationError);
  });
  it("rejects empty premises array", () => {
    expect(() => validateAxiomEntry({ ...ok, premises: [] })).toThrow(AxiomValidationError);
  });
  it("rejects > 10 premises", () => {
    expect(() => validateAxiomEntry({ ...ok, premises: Array(11).fill("x") })).toThrow(AxiomValidationError);
  });
  it("rejects a premise > 500 chars", () => {
    expect(() => validateAxiomEntry({ ...ok, premises: ["x", "y".repeat(501)] })).toThrow(AxiomValidationError);
  });
  it("rejects reasoning > 2000 chars", () => {
    expect(() => validateAxiomEntry({ ...ok, reasoning: "x".repeat(2001) })).toThrow(AxiomValidationError);
  });
  it("rejects scope > 200 chars", () => {
    expect(() => validateAxiomEntry({ ...ok, scope: "x".repeat(201) })).toThrow(AxiomValidationError);
  });
  it("rejects empty reasoning and empty scope", () => {
    expect(() => validateAxiomEntry({ ...ok, reasoning: "" })).toThrow(AxiomValidationError);
    expect(() => validateAxiomEntry({ ...ok, scope: "" })).toThrow(AxiomValidationError);
  });
  it("forwards id validation failures", () => {
    expect(() => validateAxiomEntry({ ...ok, id: "BAD ID" })).toThrow(AxiomValidationError);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd plugins/llm-axioms && bun test test/schema.test.ts && cd ../..`
Expected: errors importing from `../schema.ts` (module not found).

- [ ] **Step 3: Implement `schema.ts`**

Create `plugins/llm-axioms/schema.ts`:

```typescript
export class AxiomValidationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "AxiomValidationError";
  }
}

const ID_RE = /^[a-z0-9_-]{1,64}$/;

export function validateAxiomId(id: unknown): asserts id is string {
  if (typeof id !== "string" || !ID_RE.test(id)) {
    throw new AxiomValidationError("invalid_id", `axiom id must match /^[a-z0-9_-]{1,64}$/, got ${JSON.stringify(id)}`);
  }
}

export interface AxiomEntryInput {
  id: string;
  statement: string;
  premises: string[];
  reasoning: string;
  scope: string;
}

const MAX_STATEMENT = 280;
const MAX_PREMISE = 500;
const MAX_PREMISES = 10;
const MAX_REASONING = 2000;
const MAX_SCOPE = 200;

function nonEmptyString(v: unknown, max: number, field: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new AxiomValidationError(`empty_${field}`, `${field} must be a non-empty string`);
  }
  if (v.length > max) {
    throw new AxiomValidationError(`${field}_too_long`, `${field} exceeds ${max} chars (got ${v.length})`);
  }
  return v;
}

export function validateAxiomEntry(entry: AxiomEntryInput): void {
  validateAxiomId(entry.id);
  nonEmptyString(entry.statement, MAX_STATEMENT, "statement");
  nonEmptyString(entry.reasoning, MAX_REASONING, "reasoning");
  nonEmptyString(entry.scope, MAX_SCOPE, "scope");

  if (!Array.isArray(entry.premises) || entry.premises.length === 0) {
    throw new AxiomValidationError("empty_premises", "premises must be a non-empty array");
  }
  if (entry.premises.length > MAX_PREMISES) {
    throw new AxiomValidationError("too_many_premises", `at most ${MAX_PREMISES} premises (got ${entry.premises.length})`);
  }
  for (const p of entry.premises) {
    nonEmptyString(p, MAX_PREMISE, "premise");
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd plugins/llm-axioms && bun test test/schema.test.ts && cd ../..`
Expected: all schema tests pass.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-axioms/schema.ts plugins/llm-axioms/test/schema.test.ts
git commit -m "feat(llm-axioms): id + entry validation (schema.ts)"
```

---

## Task 4: `paths.ts` — directory + file path helpers (TDD)

**Files:**
- Create: `plugins/llm-axioms/test/paths.test.ts`
- Create: `plugins/llm-axioms/paths.ts`

- [ ] **Step 1: Write the failing tests**

Create `plugins/llm-axioms/test/paths.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, existsSync, writeFileSync, statSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAxiomsDir, ensureDir, sessionFilePath, sweepStaleTempFiles } from "../paths.ts";

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "llm-axioms-paths-")); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe("resolveAxiomsDir", () => {
  it("expands ~/ against home", () => {
    expect(resolveAxiomsDir({ home: "/home/test", configured: "~/foo/bar" })).toBe("/home/test/foo/bar");
  });
  it("returns absolute paths unchanged", () => {
    expect(resolveAxiomsDir({ home: "/x", configured: "/abs/path" })).toBe("/abs/path");
  });
  it("falls back to default when configured is empty", () => {
    expect(resolveAxiomsDir({ home: "/h", configured: "" })).toBe("/h/.kaizen/plugins/llm-axioms/sessions");
  });
});

describe("ensureDir", () => {
  it("creates a missing dir, idempotent", async () => {
    const p = join(tmp, "a/b/c");
    await ensureDir(p);
    expect(existsSync(p)).toBe(true);
    await ensureDir(p);
    expect(existsSync(p)).toBe(true);
  });
});

describe("sessionFilePath", () => {
  it("joins dir + session id + .json", () => {
    expect(sessionFilePath("/x/y", "abc")).toBe("/x/y/abc.json");
  });
});

describe("sweepStaleTempFiles", () => {
  it("removes .tmp.* files older than the threshold", async () => {
    await ensureDir(tmp);
    const stale = join(tmp, "x.json.tmp.123.abc");
    const fresh = join(tmp, "y.json.tmp.999.def");
    writeFileSync(stale, "old");
    writeFileSync(fresh, "new");
    // Backdate the stale file's mtime.
    const past = new Date(Date.now() - 120_000);
    require("node:fs").utimesSync(stale, past, past);
    await sweepStaleTempFiles(tmp, 60_000);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });
  it("leaves non-tmp files alone", async () => {
    await ensureDir(tmp);
    const keep = join(tmp, "abc.json");
    writeFileSync(keep, "real");
    require("node:fs").utimesSync(keep, new Date(0), new Date(0));
    await sweepStaleTempFiles(tmp, 60_000);
    expect(existsSync(keep)).toBe(true);
  });
  it("no-ops on missing dir", async () => {
    await sweepStaleTempFiles(join(tmp, "missing"), 60_000);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd plugins/llm-axioms && bun test test/paths.test.ts && cd ../..`
Expected: module-not-found errors.

- [ ] **Step 3: Implement `paths.ts`**

Create `plugins/llm-axioms/paths.ts`:

```typescript
import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

const DEFAULT_REL = ".kaizen/plugins/llm-axioms/sessions";

export function resolveAxiomsDir(opts: { home: string; configured?: string }): string {
  const c = (opts.configured ?? "").trim();
  if (c.length === 0) return join(opts.home, DEFAULT_REL);
  if (c.startsWith("~/")) return join(opts.home, c.slice(2));
  if (c === "~") return opts.home;
  return c;
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export function sessionFilePath(dir: string, sessionId: string): string {
  return join(dir, `${sessionId}.json`);
}

const TMP_RE = /\.tmp\.[^/]+$/;

export async function sweepStaleTempFiles(dir: string, staleMs: number): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return; // missing dir is fine
  }
  const cutoff = Date.now() - staleMs;
  for (const e of entries) {
    if (!TMP_RE.test(e)) continue;
    const full = join(dir, e);
    try {
      const st = await stat(full);
      if (st.mtimeMs < cutoff) {
        await unlink(full);
      }
    } catch {
      // best effort
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd plugins/llm-axioms && bun test test/paths.test.ts && cd ../..`
Expected: all paths tests pass.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-axioms/paths.ts plugins/llm-axioms/test/paths.test.ts
git commit -m "feat(llm-axioms): path resolution + stale temp sweep (paths.ts)"
```

---

## Task 5: `config.ts` — defaults + schema for `config:store` (TDD)

**Files:**
- Create: `plugins/llm-axioms/test/config.test.ts`
- Create: `plugins/llm-axioms/config.ts`

- [ ] **Step 1: Write the failing tests**

Create `plugins/llm-axioms/test/config.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import { DEFAULT_CONFIG, CONFIG_SCHEMA } from "../config.ts";

describe("DEFAULT_CONFIG", () => {
  it("uses the expected defaults", () => {
    expect(DEFAULT_CONFIG.axiomsDir).toBe("~/.kaizen/plugins/llm-axioms/sessions");
    expect(DEFAULT_CONFIG.injectionByteCap).toBe(4096);
    expect(DEFAULT_CONFIG.methodologyEnabled).toBe(true);
    expect(DEFAULT_CONFIG.workspaceEnabled).toBe(true);
    expect(DEFAULT_CONFIG.staleTempMs).toBe(60_000);
  });
});

describe("CONFIG_SCHEMA", () => {
  it("declares the expected fields", () => {
    expect(Object.keys(CONFIG_SCHEMA).sort()).toEqual(
      ["axiomsDir", "injectionByteCap", "methodologyEnabled", "staleTempMs", "workspaceEnabled"].sort(),
    );
    expect(CONFIG_SCHEMA.injectionByteCap.type).toBe("number");
    expect(CONFIG_SCHEMA.methodologyEnabled.type).toBe("boolean");
    expect(CONFIG_SCHEMA.workspaceEnabled.type).toBe("boolean");
    expect(CONFIG_SCHEMA.axiomsDir.type).toBe("string");
    expect(CONFIG_SCHEMA.staleTempMs.type).toBe("number");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd plugins/llm-axioms && bun test test/config.test.ts && cd ../..`
Expected: module-not-found errors.

- [ ] **Step 3: Implement `config.ts`**

Create `plugins/llm-axioms/config.ts`:

```typescript
import type { FieldSchema } from "llm-contracts/public";
import type { AxiomsConfig } from "./public.d.ts";

export const DEFAULT_CONFIG: AxiomsConfig = Object.freeze({
  axiomsDir: "~/.kaizen/plugins/llm-axioms/sessions",
  injectionByteCap: 4096,
  methodologyEnabled: true,
  workspaceEnabled: true,
  staleTempMs: 60_000,
}) as AxiomsConfig;

// Use a plain Record over the AxiomsConfig keys so this compiles whether or
// not `ConfigSchema` is generic in the contracts module — matches llm-memory's
// inline-object precedent.
export const CONFIG_SCHEMA: Record<keyof AxiomsConfig, FieldSchema> = {
  axiomsDir: { type: "string" },
  injectionByteCap: { type: "number", min: 0 },
  methodologyEnabled: { type: "boolean" },
  workspaceEnabled: { type: "boolean" },
  staleTempMs: { type: "number", min: 0 },
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd plugins/llm-axioms && bun test test/config.test.ts && cd ../..`
Expected: all config tests pass.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-axioms/config.ts plugins/llm-axioms/test/config.test.ts
git commit -m "feat(llm-axioms): config defaults + schema (config.ts)"
```

---

## Task 6: `methodology.ts` — static prompt section content (TDD)

**Files:**
- Create: `plugins/llm-axioms/test/methodology.test.ts`
- Create: `plugins/llm-axioms/methodology.ts`

- [ ] **Step 1: Write the failing tests**

Create `plugins/llm-axioms/test/methodology.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import { renderMethodology, METHODOLOGY_TEXT } from "../methodology.ts";

describe("renderMethodology", () => {
  it("returns a non-empty string with the canonical heading", () => {
    const out = renderMethodology();
    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain("# First-principles reasoning");
  });
  it("returns the same string instance across calls (cache identity)", () => {
    const a = renderMethodology();
    const b = renderMethodology();
    expect(a === b).toBe(true);
  });
  it("mentions the three tool names", () => {
    const out = renderMethodology();
    expect(out).toContain("axiom_record");
    expect(out).toContain("axiom_amend");
    expect(out).toContain("axiom_drop");
  });
  it("teaches the four-part axiom structure", () => {
    const out = renderMethodology();
    expect(out).toMatch(/statement/i);
    expect(out).toMatch(/premises/i);
    expect(out).toMatch(/reasoning/i);
    expect(out).toMatch(/scope/i);
  });
  it("exposes the constant directly", () => {
    expect(METHODOLOGY_TEXT).toBe(renderMethodology());
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd plugins/llm-axioms && bun test test/methodology.test.ts && cd ../..`
Expected: module-not-found errors.

- [ ] **Step 3: Implement `methodology.ts`**

Create `plugins/llm-axioms/methodology.ts`:

```typescript
export const METHODOLOGY_TEXT: string = [
  "# First-principles reasoning",
  "",
  "When a request contains vague qualifiers (\"world-class\", \"robust\", \"production-grade\"),",
  "conflicting constraints, novel problems, or appeals to precedent (\"we've always done it",
  "this way\"), pause and derive axioms before producing a solution.",
  "",
  "An axiom in this workspace is a *premised, scoped* truth — not an opinion or a preference.",
  "It has:",
  "- a one-sentence **statement** (declarative, falsifiable),",
  "- one or more **premises** it rests on (cite other axioms with `[[id]]`),",
  "- **reasoning** for why premises imply the statement,",
  "- a **scope** of applicability (which part of this session's problem it constrains).",
  "",
  "Use `axiom_record` before applying an axiom in your reasoning. Use `axiom_amend` when a",
  "later observation refines it. Use `axiom_drop` (with a reason) when you discover an axiom",
  "is wrong or has been superseded.",
  "",
  "Cite axioms by id (`[[id]]`) when applying them, so reasoning chains stay legible.",
].join("\n");

export function renderMethodology(): string {
  return METHODOLOGY_TEXT;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd plugins/llm-axioms && bun test test/methodology.test.ts && cd ../..`
Expected: all methodology tests pass.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-axioms/methodology.ts plugins/llm-axioms/test/methodology.test.ts
git commit -m "feat(llm-axioms): static methodology section (methodology.ts)"
```

---

## Task 7: `injection.ts` — workspace section renderer (TDD)

**Files:**
- Create: `plugins/llm-axioms/test/injection.test.ts`
- Create: `plugins/llm-axioms/injection.ts`

- [ ] **Step 1: Write the failing tests**

Create `plugins/llm-axioms/test/injection.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import { buildWorkspaceBlock } from "../injection.ts";
import type { AxiomEntry } from "../public.d.ts";

const a = (over: Partial<AxiomEntry>): AxiomEntry => ({
  id: "x",
  statement: "s",
  premises: ["p"],
  reasoning: "r",
  scope: "default",
  derivedAt: 1000,
  ...over,
});

describe("buildWorkspaceBlock", () => {
  it("returns null on empty input", () => {
    expect(buildWorkspaceBlock([], 4096)).toBeNull();
  });
  it("wraps output in <system-reminder>", () => {
    const out = buildWorkspaceBlock([a({ id: "one", statement: "S1" })], 4096)!;
    expect(out.startsWith("<system-reminder>")).toBe(true);
    expect(out.endsWith("</system-reminder>")).toBe(true);
  });
  it("groups by scope, listing axiom id + statement in each group", () => {
    const out = buildWorkspaceBlock(
      [
        a({ id: "u1", statement: "UX truth", scope: "UX" }),
        a({ id: "u2", statement: "Another UX truth", scope: "UX" }),
        a({ id: "a1", statement: "Auth truth", scope: "Auth" }),
      ],
      4096,
    )!;
    expect(out).toContain("## UX");
    expect(out).toContain("## Auth");
    expect(out).toContain("u1");
    expect(out).toContain("UX truth");
    expect(out).toContain("Another UX truth");
    expect(out).toContain("a1");
    expect(out).toContain("Auth truth");
  });
  it("includes premises and reasoning per axiom", () => {
    const out = buildWorkspaceBlock(
      [a({ id: "k", statement: "S", premises: ["alpha", "beta"], reasoning: "because" })],
      4096,
    )!;
    expect(out).toContain("alpha");
    expect(out).toContain("beta");
    expect(out).toContain("because");
  });
  it("truncates oldest-first when over byte cap and appends [truncated]", () => {
    const big = "X".repeat(200);
    const items = [
      a({ id: "old", statement: big, derivedAt: 1 }),
      a({ id: "new", statement: big, derivedAt: 2 }),
    ];
    const out = buildWorkspaceBlock(items, 220)!;
    expect(out).toContain("[truncated]");
    expect(out).toContain("new");
    // "old" might still appear in the truncation marker line, but not as a header
    expect(out.includes("### old")).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd plugins/llm-axioms && bun test test/injection.test.ts && cd ../..`
Expected: module-not-found errors.

- [ ] **Step 3: Implement `injection.ts`**

Create `plugins/llm-axioms/injection.ts`:

```typescript
import type { AxiomEntry } from "./public.d.ts";

function renderOne(a: AxiomEntry): string {
  const premiseLines = a.premises.map((p, i) => `  ${i + 1}. ${p}`).join("\n");
  return [
    `### ${a.id}`,
    `**Statement:** ${a.statement}`,
    `**Premises:**`,
    premiseLines,
    `**Reasoning:** ${a.reasoning}`,
  ].join("\n");
}

function groupByScope(entries: readonly AxiomEntry[]): Map<string, AxiomEntry[]> {
  const out = new Map<string, AxiomEntry[]>();
  for (const e of entries) {
    const arr = out.get(e.scope) ?? [];
    arr.push(e);
    out.set(e.scope, arr);
  }
  return out;
}

export function buildWorkspaceBlock(
  entries: readonly AxiomEntry[],
  byteCap: number,
): string | null {
  if (entries.length === 0) return null;

  // Drop oldest first until we fit. derivedAt ascending = oldest first.
  const sorted = [...entries].sort((a, b) => a.derivedAt - b.derivedAt);
  const keep = [...sorted];
  let truncated = false;

  const assemble = (kept: AxiomEntry[]): string => {
    const groups = groupByScope(kept);
    const body: string[] = [];
    for (const [scope, items] of groups) {
      body.push(`## ${scope}`);
      for (const e of items) body.push(renderOne(e));
    }
    if (truncated) body.push("_... [truncated]_");
    return [
      "<system-reminder>",
      "# Session axioms",
      "",
      body.join("\n\n"),
      "</system-reminder>",
    ].join("\n");
  };

  while (keep.length > 0 && Buffer.byteLength(assemble(keep), "utf8") > byteCap) {
    keep.shift();
    truncated = true;
  }
  if (keep.length === 0) {
    truncated = true;
    return assemble([]); // empty body but the truncation notice remains
  }
  return assemble(keep);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd plugins/llm-axioms && bun test test/injection.test.ts && cd ../..`
Expected: all injection tests pass.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-axioms/injection.ts plugins/llm-axioms/test/injection.test.ts
git commit -m "feat(llm-axioms): workspace section renderer (injection.ts)"
```

---

## Task 8: `store.ts` — in-memory + disk axiom store (TDD)

**Files:**
- Create: `plugins/llm-axioms/test/store.test.ts`
- Create: `plugins/llm-axioms/store.ts`

- [ ] **Step 1: Write the failing tests (suite 1 of 3: record/get/list)**

Create `plugins/llm-axioms/test/store.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, existsSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeStore } from "../store.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "llm-axioms-store-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const sample = () => ({
  id: "a1",
  statement: "S",
  premises: ["p1"],
  reasoning: "r",
  scope: "default",
});

describe("store before any session is active", () => {
  it("list() returns empty array", () => {
    const s = makeStore({ axiomsDir: dir });
    expect(s.list()).toEqual([]);
  });
  it("record() rejects with no_active_session", async () => {
    const s = makeStore({ axiomsDir: dir });
    await expect(s.record(sample())).rejects.toThrow(/no_active_session/);
  });
  it("amend() and drop() reject with no_active_session", async () => {
    const s = makeStore({ axiomsDir: dir });
    await expect(s.amend("a1", { statement: "S2" })).rejects.toThrow(/no_active_session/);
    await expect(s.drop("a1", "wrong")).rejects.toThrow(/no_active_session/);
  });
  it("clear() is a no-op", async () => {
    const s = makeStore({ axiomsDir: dir });
    await s.clear();
  });
});

describe("store with an active session", () => {
  it("record() persists to disk and is readable via list/get", async () => {
    const s = makeStore({ axiomsDir: dir, now: () => 1_700_000_000_000 });
    await s.swapSession("sess-1");
    const out = await s.record(sample());
    expect(out.id).toBe("a1");
    expect(out.derivedAt).toBe(1_700_000_000_000);
    expect(s.list().length).toBe(1);
    expect(s.get("a1")!.statement).toBe("S");
    const file = readFileSync(join(dir, "sess-1.json"), "utf8");
    const parsed = JSON.parse(file);
    expect(parsed.sessionId).toBe("sess-1");
    expect(parsed.axioms.length).toBe(1);
    expect(parsed.version).toBe(1);
  });
  it("record() refuses duplicate ids", async () => {
    const s = makeStore({ axiomsDir: dir });
    await s.swapSession("sess-1");
    await s.record(sample());
    await expect(s.record(sample())).rejects.toThrow(/axiom_exists/);
  });
  it("amend() patches only provided fields and updates amendedAt", async () => {
    let t = 1000;
    const s = makeStore({ axiomsDir: dir, now: () => t });
    await s.swapSession("sess-1");
    await s.record(sample());
    t = 2000;
    const a = await s.amend("a1", { statement: "S2" });
    expect(a.statement).toBe("S2");
    expect(a.premises).toEqual(["p1"]);
    expect(a.derivedAt).toBe(1000);
    expect(a.amendedAt).toBe(2000);
  });
  it("amend() rejects unknown id", async () => {
    const s = makeStore({ axiomsDir: dir });
    await s.swapSession("sess-1");
    await expect(s.amend("ghost", { statement: "x" })).rejects.toThrow(/axiom_not_found/);
  });
  it("drop() removes the axiom and returns true", async () => {
    const s = makeStore({ axiomsDir: dir });
    await s.swapSession("sess-1");
    await s.record(sample());
    expect(await s.drop("a1", "wrong")).toBe(true);
    expect(s.list().length).toBe(0);
  });
  it("drop() rejects unknown id", async () => {
    const s = makeStore({ axiomsDir: dir });
    await s.swapSession("sess-1");
    await expect(s.drop("ghost", "wrong")).rejects.toThrow(/axiom_not_found/);
  });
  it("clear() removes all axioms in current session only", async () => {
    const s = makeStore({ axiomsDir: dir });
    await s.swapSession("sess-1");
    await s.record(sample());
    await s.record({ ...sample(), id: "a2" });
    await s.swapSession("sess-2");
    await s.record(sample());
    await s.clear();
    expect(s.list().length).toBe(0);
    await s.swapSession("sess-1");
    expect(s.list().length).toBe(2);
  });
});

describe("swapSession", () => {
  it("loads existing session file from disk", async () => {
    writeFileSync(
      join(dir, "sess-x.json"),
      JSON.stringify({ version: 1, sessionId: "sess-x", axioms: [{ id: "ax", statement: "s", premises: ["p"], reasoning: "r", scope: "z", derivedAt: 1 }] }),
    );
    const s = makeStore({ axiomsDir: dir });
    await s.swapSession("sess-x");
    expect(s.list().length).toBe(1);
    expect(s.get("ax")!.statement).toBe("s");
  });
  it("starts empty when session file does not exist", async () => {
    const s = makeStore({ axiomsDir: dir });
    await s.swapSession("brand-new");
    expect(s.list()).toEqual([]);
  });
  it("treats malformed JSON as empty (does not throw)", async () => {
    writeFileSync(join(dir, "broken.json"), "{not json");
    const s = makeStore({ axiomsDir: dir });
    await s.swapSession("broken");
    expect(s.list()).toEqual([]);
  });
  it("fires onChange once per swap", async () => {
    const s = makeStore({ axiomsDir: dir });
    let n = 0;
    s.onChange(() => { n++; });
    await s.swapSession("a");
    await s.swapSession("b");
    expect(n).toBe(2);
  });
});

describe("onChange", () => {
  it("fires exactly once per successful mutation", async () => {
    const s = makeStore({ axiomsDir: dir });
    await s.swapSession("sess-1");
    let n = 0;
    s.onChange(() => { n++; });
    await s.record(sample());
    expect(n).toBe(1);
    await s.amend("a1", { reasoning: "r2" });
    expect(n).toBe(2);
    await s.drop("a1", "stale");
    expect(n).toBe(3);
    await s.clear();
    expect(n).toBe(4);
  });
  it("does not fire on validation failure", async () => {
    const s = makeStore({ axiomsDir: dir });
    await s.swapSession("sess-1");
    let n = 0;
    s.onChange(() => { n++; });
    await expect(s.record({ ...sample(), id: "BAD ID" })).rejects.toThrow();
    expect(n).toBe(0);
  });
  it("unsubscribe stops further notifications", async () => {
    const s = makeStore({ axiomsDir: dir });
    await s.swapSession("sess-1");
    let n = 0;
    const off = s.onChange(() => { n++; });
    await s.record(sample());
    off();
    await s.amend("a1", { reasoning: "r2" });
    expect(n).toBe(1);
  });
});

describe("atomic writes", () => {
  it("leaves no tmp files after a successful write", async () => {
    const s = makeStore({ axiomsDir: dir });
    await s.swapSession("sess-1");
    await s.record(sample());
    const fs = require("node:fs");
    const remaining = fs.readdirSync(dir).filter((n: string) => n.includes(".tmp."));
    expect(remaining).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd plugins/llm-axioms && bun test test/store.test.ts && cd ../..`
Expected: module-not-found errors.

- [ ] **Step 3: Implement `store.ts`**

Create `plugins/llm-axioms/store.ts`:

```typescript
import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { AxiomEntry, AxiomsRegistryService } from "./public.d.ts";
import { validateAxiomId, validateAxiomEntry, AxiomValidationError } from "./schema.ts";
import { sessionFilePath } from "./paths.ts";

export interface MakeStoreOpts {
  axiomsDir: string;
  now?: () => number;
  log?: (msg: string) => void;
}

interface DiskShape {
  version: 1;
  sessionId: string;
  axioms: AxiomEntry[];
}

export function makeStore(opts: MakeStoreOpts): AxiomsRegistryService & { swapSession(id: string | null): Promise<void> } {
  const dir = opts.axiomsDir;
  const now = opts.now ?? (() => Date.now());
  const log = opts.log ?? (() => {});
  let activeSession: string | null = null;
  let entries: Map<string, AxiomEntry> = new Map();
  const listeners = new Set<() => void>();

  if (!existsSync(dir)) {
    try { mkdirSync(dir, { recursive: true }); } catch {}
  }

  const fire = () => {
    for (const cb of listeners) {
      try { cb(); } catch (e) { log(`onChange listener threw: ${(e as Error).message}`); }
    }
  };

  const requireSession = (): string => {
    if (!activeSession) {
      throw new Error("no_active_session: call swapSession() before mutating");
    }
    return activeSession;
  };

  const persist = async (): Promise<void> => {
    const sid = requireSession();
    const target = sessionFilePath(dir, sid);
    const payload: DiskShape = {
      version: 1,
      sessionId: sid,
      axioms: Array.from(entries.values()),
    };
    const tmp = `${target}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
    await writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
    try {
      await rename(tmp, target);
    } catch (err) {
      try { await unlink(tmp); } catch {}
      throw err;
    }
  };

  const service: AxiomsRegistryService & { swapSession(id: string | null): Promise<void> } = {
    list() {
      return Array.from(entries.values());
    },
    get(id) {
      return entries.get(id) ?? null;
    },
    async record(input) {
      requireSession();
      validateAxiomEntry(input);
      if (entries.has(input.id)) {
        throw new AxiomValidationError("axiom_exists", `axiom "${input.id}" already exists`);
      }
      const full: AxiomEntry = { ...input, derivedAt: now() };
      const prev = new Map(entries);
      entries.set(full.id, full);
      try {
        await persist();
      } catch (e) {
        entries = prev;
        throw e;
      }
      fire();
      return full;
    },
    async amend(id, patch) {
      requireSession();
      validateAxiomId(id);
      const existing = entries.get(id);
      if (!existing) throw new AxiomValidationError("axiom_not_found", `axiom "${id}" not found`);
      const merged: AxiomEntry = {
        ...existing,
        ...("statement" in patch ? { statement: patch.statement ?? existing.statement } : {}),
        ...("premises" in patch ? { premises: patch.premises ?? existing.premises } : {}),
        ...("reasoning" in patch ? { reasoning: patch.reasoning ?? existing.reasoning } : {}),
        ...("scope" in patch ? { scope: patch.scope ?? existing.scope } : {}),
        amendedAt: now(),
      };
      validateAxiomEntry(merged);
      const prev = new Map(entries);
      entries.set(id, merged);
      try {
        await persist();
      } catch (e) {
        entries = prev;
        throw e;
      }
      fire();
      return merged;
    },
    async drop(id, reason) {
      requireSession();
      validateAxiomId(id);
      if (!entries.has(id)) {
        throw new AxiomValidationError("axiom_not_found", `axiom "${id}" not found`);
      }
      if (typeof reason !== "string" || reason.length === 0 || reason.length > 500) {
        throw new AxiomValidationError("invalid_reason", "drop reason must be a non-empty string ≤ 500 chars");
      }
      const prev = new Map(entries);
      entries.delete(id);
      try {
        await persist();
      } catch (e) {
        entries = prev;
        throw e;
      }
      fire();
      return true;
    },
    async clear() {
      if (!activeSession) return;
      const prev = new Map(entries);
      entries = new Map();
      try {
        await persist();
      } catch (e) {
        entries = prev;
        throw e;
      }
      fire();
    },
    onChange(cb) {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
    async swapSession(sessionId) {
      // Build the next map in a local before swapping, so readers calling
      // list()/get() during the await window see the old set, not an empty
      // intermediate. The swap itself is synchronous.
      const next = new Map<string, AxiomEntry>();
      if (sessionId) {
        const f = sessionFilePath(dir, sessionId);
        if (existsSync(f)) {
          try {
            const raw = await readFile(f, "utf8");
            const parsed = JSON.parse(raw) as DiskShape;
            if (parsed && Array.isArray(parsed.axioms)) {
              for (const e of parsed.axioms) {
                if (typeof e?.id === "string") next.set(e.id, e);
              }
            }
          } catch (e) {
            log(`swapSession: failed to load ${f}: ${(e as Error).message}; starting empty`);
          }
        }
      }
      activeSession = sessionId;
      entries = next;
      fire();
    },
  };

  return service;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd plugins/llm-axioms && bun test test/store.test.ts && cd ../..`
Expected: all store tests pass.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-axioms/store.ts plugins/llm-axioms/test/store.test.ts
git commit -m "feat(llm-axioms): in-memory + disk store with swapSession (store.ts)"
```

---

## Task 9: `tools.ts` — three model-facing tools (TDD)

**Files:**
- Create: `plugins/llm-axioms/test/tools.test.ts`
- Create: `plugins/llm-axioms/tools.ts`

- [ ] **Step 1: Write the failing tests**

Create `plugins/llm-axioms/test/tools.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeStore } from "../store.ts";
import { registerTools, type ToolsRegistryLike } from "../tools.ts";

function fakeRegistry() {
  const handlers: Record<string, { schema: any; handler: (args: any, ctx: any) => Promise<unknown> }> = {};
  const reg: ToolsRegistryLike = {
    register(schema, handler) {
      handlers[schema.name] = { schema, handler };
      return () => { delete handlers[schema.name]; };
    },
  };
  return { reg, handlers };
}

const sample = () => ({
  id: "a1", statement: "S", premises: ["p"], reasoning: "r", scope: "default",
});

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "llm-axioms-tools-")); });

describe("registerTools", () => {
  it("registers axiom_record / axiom_amend / axiom_drop", async () => {
    const s = makeStore({ axiomsDir: dir });
    await s.swapSession("sess-1");
    const { reg, handlers } = fakeRegistry();
    registerTools(reg, s);
    expect(Object.keys(handlers).sort()).toEqual(["axiom_amend", "axiom_drop", "axiom_record"]);
  });
  it("each tool is tagged ['axioms', 'write']", async () => {
    const s = makeStore({ axiomsDir: dir });
    await s.swapSession("sess-1");
    const { reg, handlers } = fakeRegistry();
    registerTools(reg, s);
    for (const name of ["axiom_record", "axiom_amend", "axiom_drop"]) {
      expect(handlers[name].schema.tags).toEqual(["axioms", "write"]);
    }
  });
});

describe("axiom_record handler", () => {
  it("happy path returns { ok: true, axiom }", async () => {
    const s = makeStore({ axiomsDir: dir, now: () => 1234 });
    await s.swapSession("sess-1");
    const { reg, handlers } = fakeRegistry();
    registerTools(reg, s);
    const out = await handlers.axiom_record.handler(sample(), {});
    expect(out).toMatchObject({ ok: true, axiom: { id: "a1", derivedAt: 1234 } });
  });
  it("duplicate id returns structured error", async () => {
    const s = makeStore({ axiomsDir: dir });
    await s.swapSession("sess-1");
    const { reg, handlers } = fakeRegistry();
    registerTools(reg, s);
    await handlers.axiom_record.handler(sample(), {});
    const out = await handlers.axiom_record.handler(sample(), {});
    expect(out).toMatchObject({ ok: false, error: "axiom_exists" });
  });
  it("invalid id returns structured error", async () => {
    const s = makeStore({ axiomsDir: dir });
    await s.swapSession("sess-1");
    const { reg, handlers } = fakeRegistry();
    registerTools(reg, s);
    const out = await handlers.axiom_record.handler({ ...sample(), id: "BAD" }, {});
    expect(out).toMatchObject({ ok: false, error: "invalid_id" });
  });
  it("no active session returns structured error", async () => {
    const s = makeStore({ axiomsDir: dir });
    const { reg, handlers } = fakeRegistry();
    registerTools(reg, s);
    const out = await handlers.axiom_record.handler(sample(), {});
    expect(out).toMatchObject({ ok: false, error: "no_active_session" });
  });
});

describe("axiom_amend handler", () => {
  it("amends an existing axiom", async () => {
    const s = makeStore({ axiomsDir: dir });
    await s.swapSession("sess-1");
    const { reg, handlers } = fakeRegistry();
    registerTools(reg, s);
    await handlers.axiom_record.handler(sample(), {});
    const out = await handlers.axiom_amend.handler({ id: "a1", statement: "S2" }, {});
    expect(out).toMatchObject({ ok: true, axiom: { statement: "S2" } });
  });
  it("requires at least one patch field", async () => {
    const s = makeStore({ axiomsDir: dir });
    await s.swapSession("sess-1");
    const { reg, handlers } = fakeRegistry();
    registerTools(reg, s);
    await handlers.axiom_record.handler(sample(), {});
    const out = await handlers.axiom_amend.handler({ id: "a1" }, {});
    expect(out).toMatchObject({ ok: false, error: "no_patch_fields" });
  });
  it("unknown id returns structured error", async () => {
    const s = makeStore({ axiomsDir: dir });
    await s.swapSession("sess-1");
    const { reg, handlers } = fakeRegistry();
    registerTools(reg, s);
    const out = await handlers.axiom_amend.handler({ id: "ghost", statement: "x" }, {});
    expect(out).toMatchObject({ ok: false, error: "axiom_not_found" });
  });
});

describe("axiom_drop handler", () => {
  it("drops with a reason", async () => {
    const s = makeStore({ axiomsDir: dir });
    await s.swapSession("sess-1");
    const { reg, handlers } = fakeRegistry();
    registerTools(reg, s);
    await handlers.axiom_record.handler(sample(), {});
    const out = await handlers.axiom_drop.handler({ id: "a1", reason: "superseded" }, {});
    expect(out).toMatchObject({ ok: true, droppedId: "a1", reason: "superseded" });
  });
  it("rejects without a reason", async () => {
    const s = makeStore({ axiomsDir: dir });
    await s.swapSession("sess-1");
    const { reg, handlers } = fakeRegistry();
    registerTools(reg, s);
    await handlers.axiom_record.handler(sample(), {});
    const out = await handlers.axiom_drop.handler({ id: "a1", reason: "" }, {});
    expect(out).toMatchObject({ ok: false, error: "invalid_reason" });
  });
  it("unknown id returns structured error", async () => {
    const s = makeStore({ axiomsDir: dir });
    await s.swapSession("sess-1");
    const { reg, handlers } = fakeRegistry();
    registerTools(reg, s);
    const out = await handlers.axiom_drop.handler({ id: "ghost", reason: "x" }, {});
    expect(out).toMatchObject({ ok: false, error: "axiom_not_found" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd plugins/llm-axioms && bun test test/tools.test.ts && cd ../..`
Expected: module-not-found errors.

- [ ] **Step 3: Implement `tools.ts`**

Create `plugins/llm-axioms/tools.ts`:

```typescript
import type { AxiomsRegistryService } from "./public.d.ts";
import { AxiomValidationError } from "./schema.ts";

export interface ToolSchemaLike {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  tags?: string[];
}

export interface ToolsRegistryLike {
  register(
    schema: ToolSchemaLike,
    handler: (args: any, ctx: any) => Promise<unknown>,
  ): () => void;
}

const TAGS = ["axioms", "write"];

const RECORD_SCHEMA: ToolSchemaLike = {
  name: "axiom_record",
  description:
    "Record a new first-principles axiom for the current session. " +
    "Use before applying the axiom in your reasoning. Each axiom has a stable id, " +
    "one-sentence statement, 1-10 premises (may reference other axioms via [[id]]), " +
    "reasoning, and scope of applicability.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["id", "statement", "premises", "reasoning", "scope"],
    properties: {
      id: { type: "string", description: "Slug, [a-z0-9_-]{1,64}, stable across amend/drop" },
      statement: { type: "string", description: "One-sentence declarative axiom (≤ 280 chars)" },
      premises: {
        type: "array",
        minItems: 1,
        maxItems: 10,
        items: { type: "string" },
      },
      reasoning: { type: "string", description: "Why premises imply the statement (≤ 2000 chars)" },
      scope: { type: "string", description: "Applicability within this session (≤ 200 chars)" },
    },
  },
  tags: TAGS,
};

const AMEND_SCHEMA: ToolSchemaLike = {
  name: "axiom_amend",
  description:
    "Refine an existing axiom in the current session by id. " +
    "Pass any subset of statement/premises/reasoning/scope.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["id"],
    properties: {
      id: { type: "string" },
      statement: { type: "string" },
      premises: { type: "array", items: { type: "string" } },
      reasoning: { type: "string" },
      scope: { type: "string" },
    },
  },
  tags: TAGS,
};

const DROP_SCHEMA: ToolSchemaLike = {
  name: "axiom_drop",
  description: "Remove an axiom from the current session. Reason is required and is audited.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["id", "reason"],
    properties: {
      id: { type: "string" },
      reason: { type: "string", description: "Why the axiom is being dropped (≤ 500 chars)" },
    },
  },
  tags: TAGS,
};

function toStructuredError(e: unknown): { ok: false; error: string; message: string } {
  if (e instanceof AxiomValidationError) {
    return { ok: false, error: e.code, message: e.message };
  }
  const msg = (e as Error)?.message ?? String(e);
  if (msg.startsWith("no_active_session")) {
    return { ok: false, error: "no_active_session", message: msg };
  }
  return { ok: false, error: "internal_error", message: msg };
}

export function registerTools(reg: ToolsRegistryLike, store: AxiomsRegistryService): () => void {
  const offs: Array<() => void> = [];

  offs.push(
    reg.register(RECORD_SCHEMA, async (args) => {
      try {
        const axiom = await store.record({
          id: String(args?.id ?? ""),
          statement: String(args?.statement ?? ""),
          premises: Array.isArray(args?.premises) ? args.premises.map(String) : [],
          reasoning: String(args?.reasoning ?? ""),
          scope: String(args?.scope ?? ""),
        });
        return { ok: true, axiom };
      } catch (e) {
        return toStructuredError(e);
      }
    }),
  );

  offs.push(
    reg.register(AMEND_SCHEMA, async (args) => {
      const id = String(args?.id ?? "");
      const patch: Record<string, unknown> = {};
      if (typeof args?.statement === "string") patch.statement = args.statement;
      if (Array.isArray(args?.premises)) patch.premises = args.premises.map(String);
      if (typeof args?.reasoning === "string") patch.reasoning = args.reasoning;
      if (typeof args?.scope === "string") patch.scope = args.scope;
      if (Object.keys(patch).length === 0) {
        return { ok: false, error: "no_patch_fields", message: "amend requires at least one of statement/premises/reasoning/scope" };
      }
      try {
        const axiom = await store.amend(id, patch as any);
        return { ok: true, axiom };
      } catch (e) {
        return toStructuredError(e);
      }
    }),
  );

  offs.push(
    reg.register(DROP_SCHEMA, async (args) => {
      const id = String(args?.id ?? "");
      const reason = String(args?.reason ?? "");
      try {
        await store.drop(id, reason);
        return { ok: true, droppedId: id, reason };
      } catch (e) {
        return toStructuredError(e);
      }
    }),
  );

  return () => { for (const off of offs) { try { off(); } catch {} } };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd plugins/llm-axioms && bun test test/tools.test.ts && cd ../..`
Expected: all tools tests pass.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-axioms/tools.ts plugins/llm-axioms/test/tools.test.ts
git commit -m "feat(llm-axioms): three model-facing tools (tools.ts)"
```

---

## Task 10: `slash.ts` — three user slash commands (TDD)

**Files:**
- Create: `plugins/llm-axioms/test/slash.test.ts`
- Create: `plugins/llm-axioms/slash.ts`

- [ ] **Step 1: Write the failing tests**

Create `plugins/llm-axioms/test/slash.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeStore } from "../store.ts";
import { registerSlashCommands, type SlashRegistryLike, type SlashCommandContextLike } from "../slash.ts";

function fakeRegistry() {
  const handlers: Record<string, (ctx: SlashCommandContextLike) => Promise<void>> = {};
  const reg: SlashRegistryLike = {
    register(manifest, handler) {
      handlers[manifest.name] = handler;
      return () => { delete handlers[manifest.name]; };
    },
  };
  return { reg, handlers };
}

function fakeCtx(args: string[] = ""): SlashCommandContextLike & { output: string[]; errors: string[] } {
  const out: string[] = [];
  const errs: string[] = [];
  return {
    args: Array.isArray(args) ? args.join(" ") : String(args),
    print(text: string) { out.push(text); },
    error(text: string) { errs.push(text); },
    output: out,
    errors: errs,
  };
}

const sample = () => ({
  id: "a1", statement: "S", premises: ["p"], reasoning: "r", scope: "default",
});

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "llm-axioms-slash-")); });

describe("axioms:list", () => {
  it("renders empty state when no axioms", async () => {
    const s = makeStore({ axiomsDir: dir });
    await s.swapSession("sess-1");
    const { reg, handlers } = fakeRegistry();
    registerSlashCommands(reg, s);
    const ctx = fakeCtx();
    await handlers["axioms:list"](ctx);
    expect(ctx.output.join("\n")).toMatch(/no axioms/i);
  });
  it("renders axioms grouped by scope with id and statement", async () => {
    const s = makeStore({ axiomsDir: dir });
    await s.swapSession("sess-1");
    await s.record({ ...sample(), id: "u1", statement: "UX truth", scope: "UX" });
    await s.record({ ...sample(), id: "a1", statement: "Auth truth", scope: "Auth" });
    const { reg, handlers } = fakeRegistry();
    registerSlashCommands(reg, s);
    const ctx = fakeCtx();
    await handlers["axioms:list"](ctx);
    const text = ctx.output.join("\n");
    expect(text).toContain("UX");
    expect(text).toContain("u1");
    expect(text).toContain("UX truth");
    expect(text).toContain("Auth");
    expect(text).toContain("a1");
  });
});

describe("axioms:show", () => {
  it("prints full detail for a known id", async () => {
    const s = makeStore({ axiomsDir: dir, now: () => 1700000000000 });
    await s.swapSession("sess-1");
    await s.record(sample());
    const { reg, handlers } = fakeRegistry();
    registerSlashCommands(reg, s);
    const ctx = fakeCtx("a1");
    await handlers["axioms:show"](ctx);
    const text = ctx.output.join("\n");
    expect(text).toContain("a1");
    expect(text).toContain("S");
    expect(text).toContain("p");
    expect(text).toContain("r");
    expect(text).toContain("default");
  });
  it("errors on missing id arg", async () => {
    const s = makeStore({ axiomsDir: dir });
    await s.swapSession("sess-1");
    const { reg, handlers } = fakeRegistry();
    registerSlashCommands(reg, s);
    const ctx = fakeCtx("");
    await handlers["axioms:show"](ctx);
    expect(ctx.errors.length).toBeGreaterThan(0);
  });
  it("errors on unknown id", async () => {
    const s = makeStore({ axiomsDir: dir });
    await s.swapSession("sess-1");
    const { reg, handlers } = fakeRegistry();
    registerSlashCommands(reg, s);
    const ctx = fakeCtx("ghost");
    await handlers["axioms:show"](ctx);
    expect(ctx.errors.length).toBeGreaterThan(0);
  });
});

describe("axioms:clear", () => {
  it("clears all axioms in the current session", async () => {
    const s = makeStore({ axiomsDir: dir });
    await s.swapSession("sess-1");
    await s.record(sample());
    await s.record({ ...sample(), id: "a2" });
    const { reg, handlers } = fakeRegistry();
    registerSlashCommands(reg, s);
    const ctx = fakeCtx();
    await handlers["axioms:clear"](ctx);
    expect(s.list().length).toBe(0);
    expect(ctx.output.join("\n")).toMatch(/cleared/i);
  });
  it("prints a notice when there's nothing to clear", async () => {
    const s = makeStore({ axiomsDir: dir });
    await s.swapSession("sess-1");
    const { reg, handlers } = fakeRegistry();
    registerSlashCommands(reg, s);
    const ctx = fakeCtx();
    await handlers["axioms:clear"](ctx);
    expect(ctx.output.join("\n")).toMatch(/no axioms/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd plugins/llm-axioms && bun test test/slash.test.ts && cd ../..`
Expected: module-not-found errors.

- [ ] **Step 3: Implement `slash.ts`**

Create `plugins/llm-axioms/slash.ts`:

```typescript
import type { AxiomEntry, AxiomsRegistryService } from "./public.d.ts";

export interface SlashCommandManifestLike {
  name: string;
  description: string;
  source?: string;
  usage?: string;
}

export interface SlashCommandContextLike {
  args: string;
  print(text: string): void;
  error(text: string): void;
}

export interface SlashRegistryLike {
  register(
    manifest: SlashCommandManifestLike,
    handler: (ctx: SlashCommandContextLike) => Promise<void>,
  ): () => void;
}

function groupByScope(entries: readonly AxiomEntry[]): Map<string, AxiomEntry[]> {
  const out = new Map<string, AxiomEntry[]>();
  for (const e of entries) {
    const arr = out.get(e.scope) ?? [];
    arr.push(e);
    out.set(e.scope, arr);
  }
  return out;
}

function renderList(entries: readonly AxiomEntry[]): string {
  if (entries.length === 0) return "No axioms in this session.";
  const groups = groupByScope(entries);
  const out: string[] = [];
  for (const [scope, items] of groups) {
    out.push(`## ${scope}`);
    for (const e of items) out.push(`- **${e.id}** — ${e.statement}`);
    out.push("");
  }
  return out.join("\n").trimEnd();
}

function renderShow(e: AxiomEntry): string {
  const out: string[] = [];
  out.push(`# ${e.id}`);
  out.push("");
  out.push(`**Statement:** ${e.statement}`);
  out.push(`**Scope:** ${e.scope}`);
  out.push(`**Premises:**`);
  e.premises.forEach((p, i) => { out.push(`  ${i + 1}. ${p}`); });
  out.push(`**Reasoning:** ${e.reasoning}`);
  out.push("");
  out.push(`*Derived: ${new Date(e.derivedAt).toISOString()}*`);
  if (e.amendedAt) out.push(`*Amended: ${new Date(e.amendedAt).toISOString()}*`);
  return out.join("\n");
}

export function registerSlashCommands(
  reg: SlashRegistryLike,
  store: AxiomsRegistryService,
): Array<() => void> {
  const offs: Array<() => void> = [];

  offs.push(reg.register(
    { name: "axioms:list", description: "List axioms recorded in the current session", source: "plugin" },
    async (ctx) => { ctx.print(renderList(store.list())); },
  ));

  offs.push(reg.register(
    { name: "axioms:show", description: "Show full detail for one axiom", source: "plugin", usage: "<id>" },
    async (ctx) => {
      const id = (ctx.args ?? "").trim();
      if (id.length === 0) {
        ctx.error("usage: /axioms:show <id>");
        return;
      }
      const e = store.get(id);
      if (!e) {
        ctx.error(`axiom "${id}" not found in this session`);
        return;
      }
      ctx.print(renderShow(e));
    },
  ));

  offs.push(reg.register(
    { name: "axioms:clear", description: "Drop all axioms in the current session", source: "plugin" },
    async (ctx) => {
      const before = store.list().length;
      if (before === 0) {
        ctx.print("No axioms in this session to clear.");
        return;
      }
      await store.clear();
      ctx.print(`Cleared ${before} axiom${before === 1 ? "" : "s"} from the current session.`);
    },
  ));

  return offs;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd plugins/llm-axioms && bun test test/slash.test.ts && cd ../..`
Expected: all slash tests pass.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-axioms/slash.ts plugins/llm-axioms/test/slash.test.ts
git commit -m "feat(llm-axioms): read + clear slash commands (slash.ts)"
```

---

## Task 11: `index.ts` — plugin lifecycle (TDD)

**Files:**
- Create: `plugins/llm-axioms/test/index.test.ts`
- Modify: `plugins/llm-axioms/index.ts`

- [ ] **Step 1: Write the failing tests**

Create `plugins/llm-axioms/test/index.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../index.ts";

interface FakeCtx {
  provided: Record<string, unknown>;
  defined: string[];
  consumed: string[];
  services: Record<string, any>;
  events: Record<string, Array<(p: any) => any>>;
  emitted: Array<{ event: string; payload: any }>;
  log: (m: string) => void;
  logs: string[];
}

function makeCtx(): FakeCtx & {
  provideService: (n: string, s: unknown) => void;
  defineService: (n: string, _spec: any) => void;
  consumeService: (n: string) => void;
  useService: <T>(n: string) => T | undefined;
  on: (event: string, cb: (p: any) => any) => void;
  emit: (event: string, payload: any) => Promise<void>;
} {
  const provided: Record<string, unknown> = {};
  const defined: string[] = [];
  const consumed: string[] = [];
  const services: Record<string, any> = {};
  const events: Record<string, Array<(p: any) => any>> = {};
  const emitted: Array<{ event: string; payload: any }> = [];
  const logs: string[] = [];
  return {
    provided, defined, consumed, services, events, emitted, logs,
    log: (m: string) => { logs.push(m); },
    provideService(n, s) { provided[n] = s; services[n] = s; },
    defineService(n) { defined.push(n); },
    consumeService(n) { consumed.push(n); },
    useService<T>(n: string): T | undefined { return services[n] as T | undefined; },
    on(event, cb) { (events[event] ??= []).push(cb); },
    async emit(event, payload) {
      emitted.push({ event, payload });
      for (const cb of events[event] ?? []) await cb(payload);
    },
  };
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "llm-axioms-index-")); });

describe("plugin manifest", () => {
  it("has the expected manifest fields", () => {
    expect(plugin.name).toBe("llm-axioms");
    expect(plugin.services?.provides).toContain("axioms:registry");
    expect(plugin.services?.consumes).toContain("events:vocabulary");
    expect(plugin.services?.consumes).toContain("prompt:registry");
    expect(plugin.services?.consumes).toContain("tools:registry");
    expect(plugin.services?.consumes).toContain("slash:registry");
    expect(plugin.services?.consumes).toContain("config:store");
  });
});

describe("setup", () => {
  it("provides axioms:registry", async () => {
    const ctx = makeCtx();
    // simulate config:store
    ctx.services["config:store"] = {
      register: () => {},
      get: () => ({ axiomsDir: dir, injectionByteCap: 4096, methodologyEnabled: true, workspaceEnabled: true, staleTempMs: 60000 }),
    };
    await plugin.setup!(ctx as any);
    expect(ctx.provided["axioms:registry"]).toBeDefined();
  });

  it("registers both prompt sections when prompt:registry is present", async () => {
    const ctx = makeCtx();
    const sections: any[] = [];
    ctx.services["prompt:registry"] = {
      register(section: any) {
        sections.push(section);
        return { unregister: () => {}, bumpGeneration: () => {} };
      },
    };
    ctx.services["config:store"] = {
      register: () => {},
      get: () => ({ axiomsDir: dir, injectionByteCap: 4096, methodologyEnabled: true, workspaceEnabled: true, staleTempMs: 60000 }),
    };
    await plugin.setup!(ctx as any);
    const ids = sections.map((s) => s.id);
    expect(ids).toContain("llm-axioms:methodology");
    expect(ids).toContain("llm-axioms:workspace");
  });

  it("skips section registration when methodologyEnabled / workspaceEnabled are false", async () => {
    const ctx = makeCtx();
    const sections: any[] = [];
    ctx.services["prompt:registry"] = {
      register(section: any) {
        sections.push(section);
        return { unregister: () => {}, bumpGeneration: () => {} };
      },
    };
    ctx.services["config:store"] = {
      register: () => {},
      get: () => ({ axiomsDir: dir, injectionByteCap: 4096, methodologyEnabled: false, workspaceEnabled: false, staleTempMs: 60000 }),
    };
    await plugin.setup!(ctx as any);
    expect(sections.length).toBe(0);
  });

  it("registers tools when tools:registry is present", async () => {
    const ctx = makeCtx();
    const tools: string[] = [];
    ctx.services["tools:registry"] = {
      register(schema: any) { tools.push(schema.name); return () => {}; },
    };
    ctx.services["config:store"] = {
      register: () => {},
      get: () => ({ axiomsDir: dir, injectionByteCap: 4096, methodologyEnabled: true, workspaceEnabled: true, staleTempMs: 60000 }),
    };
    await plugin.setup!(ctx as any);
    expect(tools.sort()).toEqual(["axiom_amend", "axiom_drop", "axiom_record"]);
  });

  it("registers slash commands when slash:registry is present", async () => {
    const ctx = makeCtx();
    const slashes: string[] = [];
    ctx.services["slash:registry"] = {
      register(manifest: any) { slashes.push(manifest.name); return () => {}; },
    };
    ctx.services["config:store"] = {
      register: () => {},
      get: () => ({ axiomsDir: dir, injectionByteCap: 4096, methodologyEnabled: true, workspaceEnabled: true, staleTempMs: 60000 }),
    };
    await plugin.setup!(ctx as any);
    expect(slashes.sort()).toEqual(["axioms:clear", "axioms:list", "axioms:show"]);
  });

  it("subscribes to session:active-changed and swaps store session", async () => {
    const ctx = makeCtx();
    ctx.services["config:store"] = {
      register: () => {},
      get: () => ({ axiomsDir: dir, injectionByteCap: 4096, methodologyEnabled: true, workspaceEnabled: true, staleTempMs: 60000 }),
    };
    await plugin.setup!(ctx as any);
    expect(ctx.events["session:active-changed"]?.length ?? 0).toBeGreaterThan(0);
    // After firing the event with a sessionId, the store should be writable.
    await ctx.emit("session:active-changed", { sessionId: "sess-test" });
    const svc = ctx.provided["axioms:registry"] as any;
    await svc.record({ id: "a1", statement: "S", premises: ["p"], reasoning: "r", scope: "z" });
    expect(svc.list().length).toBe(1);
  });

  it("degrades gracefully when config:store is absent (uses defaults)", async () => {
    const ctx = makeCtx();
    // No config:store
    await plugin.setup!(ctx as any);
    expect(ctx.provided["axioms:registry"]).toBeDefined();
  });
});

describe("stop", () => {
  it("is idempotent — second call is a no-op", async () => {
    const ctx = makeCtx();
    ctx.services["config:store"] = {
      register: () => {},
      get: () => ({ axiomsDir: dir, injectionByteCap: 4096, methodologyEnabled: true, workspaceEnabled: true, staleTempMs: 60000 }),
    };
    ctx.services["prompt:registry"] = {
      register: () => ({ unregister: () => {}, bumpGeneration: () => {} }),
    };
    ctx.services["tools:registry"] = { register: () => () => {} };
    ctx.services["slash:registry"] = { register: () => () => {} };
    await plugin.setup!(ctx as any);
    await plugin.stop!(ctx as any);
    await plugin.stop!(ctx as any);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd plugins/llm-axioms && bun test test/index.test.ts && cd ../..`
Expected: most lifecycle tests fail (stub doesn't wire anything).

- [ ] **Step 3: Implement `index.ts`**

Replace the contents of `plugins/llm-axioms/index.ts`:

```typescript
import type { KaizenPlugin } from "kaizen/types";
import type {
  ConfigStoreService,
  SystemPromptService,
  RegisteredSection,
  AxiomsRegistryService,
} from "llm-contracts/public";
import { homedir } from "node:os";
import type { AxiomsConfig } from "./public.d.ts";
import { DEFAULT_CONFIG, CONFIG_SCHEMA } from "./config.ts";
import { resolveAxiomsDir, ensureDir, sweepStaleTempFiles } from "./paths.ts";
import { makeStore } from "./store.ts";
import { renderMethodology } from "./methodology.ts";
import { buildWorkspaceBlock } from "./injection.ts";
import { registerTools, type ToolsRegistryLike } from "./tools.ts";
import { registerSlashCommands, type SlashRegistryLike } from "./slash.ts";

let methodologyHandle: RegisteredSection | undefined;
let workspaceHandle: RegisteredSection | undefined;
let toolsUnregister: (() => void) | undefined;
let slashUnregister: Array<() => void> | undefined;

const plugin: KaizenPlugin = {
  name: "llm-axioms",
  apiVersion: "3.0.0",
  permissions: { tier: "unscoped" },
  services: {
    provides: ["axioms:registry"],
    consumes: [
      "events:vocabulary",
      "config:store",
      "prompt:registry",
      "tools:registry",
      "slash:registry",
    ],
  },

  async setup(ctx) {
    const log = (m: string) => ctx.log?.(m);

    // Load config (topo-hint optional).
    let config: AxiomsConfig = { ...DEFAULT_CONFIG };
    const cfgSvc = ctx.useService<ConfigStoreService>("config:store");
    if (cfgSvc) {
      try {
        cfgSvc.register<AxiomsConfig>({
          plugin: "llm-axioms",
          defaults: { ...DEFAULT_CONFIG },
          schema: CONFIG_SCHEMA,
        });
        config = cfgSvc.get<AxiomsConfig>("llm-axioms");
      } catch (e) {
        log(`llm-axioms: config:store register failed (${(e as Error).message}); using defaults`);
      }
    } else {
      log("llm-axioms: config:store unavailable; using DEFAULT_CONFIG");
    }

    const axiomsDir = resolveAxiomsDir({ home: homedir(), configured: config.axiomsDir });
    await ensureDir(axiomsDir);
    await sweepStaleTempFiles(axiomsDir, config.staleTempMs);

    const store = makeStore({ axiomsDir, log });
    ctx.provideService<AxiomsRegistryService>("axioms:registry", store);

    // Prompt sections — register before subscribing to session changes so
    // section.bumpGeneration is wired before any swap fires.
    const promptSystem = ctx.useService<SystemPromptService>("prompt:registry");
    if (promptSystem) {
      if (config.methodologyEnabled) {
        methodologyHandle = promptSystem.register({
          id: "llm-axioms:methodology",
          priority: 50,
          render: async () => renderMethodology(),
        });
      }
      if (config.workspaceEnabled) {
        workspaceHandle = promptSystem.register({
          id: "llm-axioms:workspace",
          priority: 180,
          render: async () => {
            const block = buildWorkspaceBlock(store.list(), config.injectionByteCap);
            return block ?? "";
          },
        });
        store.onChange(() => { workspaceHandle?.bumpGeneration(); });
      }
    } else {
      log("llm-axioms: prompt:registry unavailable; sections not registered");
    }

    // Tools.
    const tools = ctx.useService<ToolsRegistryLike>("tools:registry");
    if (tools) {
      toolsUnregister = registerTools(tools, store);
    } else {
      log("llm-axioms: tools:registry unavailable; tools not registered");
    }

    // Slash commands.
    const slash = ctx.useService<SlashRegistryLike>("slash:registry");
    if (slash) {
      slashUnregister = registerSlashCommands(slash, store);
    } else {
      log("llm-axioms: slash:registry unavailable; slash commands not registered");
    }

    // Session lifecycle.
    ctx.on("session:active-changed", async (payload: unknown) => {
      const sid = (payload as { sessionId?: string } | undefined)?.sessionId ?? null;
      await store.swapSession(sid);
    });
  },

  async stop() {
    try { toolsUnregister?.(); } catch { /* idempotent */ }
    try { for (const u of slashUnregister ?? []) u(); } catch { /* idempotent */ }
    try { workspaceHandle?.unregister(); } catch { /* idempotent */ }
    try { methodologyHandle?.unregister(); } catch { /* idempotent */ }
    toolsUnregister = undefined;
    slashUnregister = undefined;
    workspaceHandle = undefined;
    methodologyHandle = undefined;
  },
};

export default plugin;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd plugins/llm-axioms && bun test && cd ../..`
Expected: all tests across all suites pass.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-axioms/index.ts plugins/llm-axioms/test/index.test.ts
git commit -m "feat(llm-axioms): plugin lifecycle wiring (index.ts)"
```

---

## Task 12: Author plugin docs (README.md, CLAUDE.md)

**Files:**
- Create: `plugins/llm-axioms/README.md`
- Create: `plugins/llm-axioms/CLAUDE.md`

- [ ] **Step 1: Create `README.md`**

```markdown
# llm-axioms

Session-scoped Aristotelean axiom workspace for the openai-compatible harness. Records first-principles axioms (statement + premises + reasoning + scope) derived during a session, persists them under `~/.kaizen/plugins/llm-axioms/sessions/<session-id>.json`, and injects them into every LLM turn alongside a static methodology section that teaches the model when to derive.

Axioms are **distinct from memories**: session-bound (not user/project), structured (with explicit premises and scope), ephemeral relative to broader durable context. If a derived axiom proves durable across problems, the user lifts it into `llm-memory` by hand.

## What it does

- Provides the `axioms:registry` service (defined in `llm-contracts`).
- Registers two `prompt:registry` sections:
  - `llm-axioms:methodology` (priority 50) — static guidance on when and how to derive first principles.
  - `llm-axioms:workspace` (priority 180) — current session's axioms, grouped by scope, truncated oldest-first to `injectionByteCap`. Drops when empty.
- Registers three tools in `tools:registry`: `axiom_record`, `axiom_amend`, `axiom_drop`. All tagged `["axioms", "write"]`. Validation failures return structured `{ ok: false, error }`.
- Registers three slash commands in `slash:registry`: `/axioms:list`, `/axioms:show <id>`, `/axioms:clear`.
- Subscribes to `session:active-changed` to swap the active session's axioms on session change.

## Wiring

### Provides

**Service** — `axioms:registry`

```typescript
interface AxiomEntry {
  id: string;             // [a-z0-9_-]{1,64}
  statement: string;
  premises: string[];
  reasoning: string;
  scope: string;
  derivedAt: number;
  amendedAt?: number;
}

interface AxiomsRegistryService {
  list(): readonly AxiomEntry[];
  get(id: string): AxiomEntry | null;
  record(entry: Omit<AxiomEntry, "derivedAt" | "amendedAt">): Promise<AxiomEntry>;
  amend(id: string, patch: Partial<Omit<AxiomEntry, "id" | "derivedAt">>): Promise<AxiomEntry>;
  drop(id: string, reason: string): Promise<boolean>;
  clear(): Promise<void>;
  onChange(cb: () => void): () => void;
}
```

### Consumes

- `events:vocabulary` — **hard**.
- `config:store` — topo-hint optional; falls back to `DEFAULT_CONFIG` if absent.
- `prompt:registry` — topo-hint optional; sections not registered if absent.
- `tools:registry` — topo-hint optional; tools not registered if absent.
- `slash:registry` — topo-hint optional; slash commands not registered if absent.
- Event `session:active-changed` — required for any writes; without it, tools return `{ ok: false, error: "no_active_session" }`.

## Configuration

Settings live under the `llm-axioms` plugin section in `config:store`:

| Key | Default | Notes |
|---|---|---|
| `axiomsDir` | `~/.kaizen/plugins/llm-axioms/sessions` | `~/` expanded. |
| `injectionByteCap` | `4096` | Workspace section cap; oldest-first truncation. |
| `methodologyEnabled` | `true` | Kill switch for the static section. |
| `workspaceEnabled` | `true` | Kill switch for the dynamic section. |
| `staleTempMs` | `60000` | Startup temp-file sweep threshold. |

## Privacy

All writes land as plain text under the configured directory. No outbound calls; axioms are sent only as part of the normal `llm:complete` request. Add `.kaizen/plugins/llm-axioms/` to your home backup policy if you want axioms to survive across machines.

## Permissions

`tier: unscoped` — reads/writes under `~/.kaizen/plugins/llm-axioms/`. No network, no process spawn.
```

- [ ] **Step 2: Create `CLAUDE.md`**

```markdown
# Working in `llm-axioms`

Notes for agents editing this plugin. See `README.md` for the user-facing contract.

## Module map

```
index.ts          Plugin lifecycle. Subscribes to session:active-changed.
                  Registers axioms:registry service, two prompt sections,
                  three tools, three slash commands. Only file touching ctx.
config.ts         DEFAULT_CONFIG (frozen) + CONFIG_SCHEMA for config:store.
paths.ts          resolveAxiomsDir, ensureDir, sessionFilePath, sweepStaleTempFiles.
                  Pure FS helpers.
schema.ts         validateAxiomId, validateAxiomEntry, AxiomValidationError.
                  Pure validators. Owns the [a-z0-9_-]{1,64} regex and length caps.
methodology.ts    METHODOLOGY_TEXT constant + renderMethodology(). Pure, cache-stable.
injection.ts      buildWorkspaceBlock(entries, byteCap). Pure render. Groups by scope;
                  truncates oldest-first when over cap.
store.ts          makeStore({ axiomsDir, log, now? }) → AxiomsRegistryService + swapSession.
                  In-memory Map<id, AxiomEntry> mirrored to disk. Atomic writes
                  (tmp + rename) with rollback on disk failure.
tools.ts          registerTools(reg, store) → unregister fn.
                  Three tools: axiom_record / axiom_amend / axiom_drop.
slash.ts          registerSlashCommands(reg, store) → Array<() => void>.
                  Three commands: axioms:list / axioms:show / axioms:clear.
public.d.ts       Re-exports AxiomEntry, AxiomsRegistryService from llm-contracts/public
                  + plugin-internal AxiomsConfig.
```

Boundaries:
- `store.ts` is the only module that touches disk.
- Only `index.ts` imports `kaizen/types` or touches `ctx`.
- Tests for each module live alongside in `test/` and run independently.

## Invariants

- **`onChange` fires exactly once per externally observable mutation.** record/amend/drop/clear/swapSession each fire once after in-memory state has been updated and disk write completed. Validation failures fire zero times. Tests assert this.
- **Disk and memory never diverge.** Every public mutation persists to disk before `onChange` fires. If the disk write fails, in-memory state rolls back and the method rejects.
- **No active session ⇒ tools error gracefully.** Before any `session:active-changed` event arrives, the store has no active session. record/amend/drop reject with `no_active_session`. `list()` returns `[]`. `clear()` is a no-op.
- **Workspace section drops when empty.** `buildWorkspaceBlock([])` returns `null`; section `render()` returns `""`; `prompt:registry` drops the section for that call. No empty `<system-reminder>` blocks.
- **Methodology section is byte-stable across renders.** `renderMethodology()` returns the same string instance between calls (cache identity, not equality).
- **ID validation is the only gate on writes.** Tools that receive an invalid id return `{ ok: false, error: "invalid_id" }` and never reach the store.
- **Drop reasons surface in the event stream.** Tool result includes `{ droppedId, reason }`; the `tool:result` event carries it for the TUI to display.
- **No call into `memory:store`.** Verified by no-import test on the bundled `dist/index.js`.
- **Stop is idempotent.** All unregister fns guarded with try/catch.

## Adding an axiom writer from another plugin

```typescript
const axioms = ctx.useService<AxiomsRegistryService>("axioms:registry");
await axioms.record({
  id: "world-class-means-offline",
  statement: "A world-class calendar must work offline.",
  premises: ["users travel", "networks fail"],
  reasoning: "Offline support is non-negotiable for primary calendar features.",
  scope: "UX baseline",
});
```

Ids must match `[a-z0-9_-]{1,64}`. `statement` ≤ 280 chars; 1-10 `premises` each ≤ 500 chars; `reasoning` ≤ 2000 chars; `scope` ≤ 200 chars.

## Editing methodology text

`methodology.ts` is intentionally narrow — a single canonical text. Changes are user-visible (the model sees the new text immediately). Update the snapshot test in `test/methodology.test.ts` and bump the plugin version.

## Testing

```bash
cd plugins/llm-axioms && bun test
```

`bun:test` only. FS-touching tests use real tmpdirs (`mkdtemp` under `os.tmpdir()`, cleanup in `afterEach`). Lifecycle test uses an in-memory fake ctx.

## Local deploy

The Kaizen runtime prefers the bundled `dist/index.js` over source. After editing:

```bash
PLUGIN=llm-axioms
VERSION=$(jq -r .version plugins/$PLUGIN/package.json)
INSTALL_DIR=~/.kaizen/marketplaces/official/plugins/${PLUGIN}@${VERSION}
(cd plugins/$PLUGIN && bun build --target=bun --outfile=dist/index.js index.ts)
mkdir -p "$INSTALL_DIR/dist"
rsync -a --exclude='node_modules' --exclude='dist' plugins/$PLUGIN/ "$INSTALL_DIR/"
cp plugins/$PLUGIN/dist/index.js "$INSTALL_DIR/dist/index.js"
```

`llm-contracts` (currently `0.3.0` — the version that defines `axioms:registry`) must be redeployed before `llm-axioms`.
```

- [ ] **Step 3: Commit**

```bash
git add plugins/llm-axioms/README.md plugins/llm-axioms/CLAUDE.md
git commit -m "docs(llm-axioms): README + CLAUDE.md"
```

---

## Task 13: Register in marketplace + harness manifest

**Files:**
- Modify: `.kaizen/marketplace.json`
- Modify: `harnesses/openai-compatible.json`

- [ ] **Step 1: Add `llm-axioms` to the marketplace**

Open `.kaizen/marketplace.json`. Find the `entries` array. Add this entry (place it near `llm-memory` or `llm-skills` to keep related plugins together):

```json
{
  "kind": "plugin",
  "name": "llm-axioms",
  "description": "Session-scoped Aristotelean axiom workspace. Provides axioms:registry + two prompt sections + three tools + three slash commands.",
  "categories": ["reasoning", "axioms"],
  "versions": [
    { "version": "0.1.0", "source": { "type": "file", "path": "plugins/llm-axioms" } }
  ]
}
```

- [ ] **Step 2: Add a new `llm-contracts` version entry**

In the same file, find the `llm-contracts` entry's `versions` array. Prepend a new version (keep older ones for back-compat):

```json
{ "version": "0.3.0", "source": { "type": "file", "path": "plugins/llm-contracts" } },
```

Should sit above the existing `0.2.0` entry.

- [ ] **Step 3: Update the harness manifest**

Open `harnesses/openai-compatible.json`. Find the `plugins` array.

- Change `"official/llm-contracts@0.2.0"` to `"official/llm-contracts@0.3.0"`.
- Add `"official/llm-axioms@0.1.0"` after `"official/llm-memory@0.1.3"` (sit next to the other reasoning-adjacent plugins).

- [ ] **Step 4: Validate marketplace JSON**

Run: `jq . .kaizen/marketplace.json > /dev/null && jq . harnesses/openai-compatible.json > /dev/null`
Expected: no output (valid JSON).

- [ ] **Step 5: Validate the plugin structure**

Run: `kaizen plugin validate plugins/llm-axioms`
Expected: validation passes; if it fails, fix manifest or permissions issues and re-run.

- [ ] **Step 6: Run the full test suite**

Run: `bun test`
Expected: all tests across all plugins pass; in particular every `llm-axioms` test passes.

- [ ] **Step 7: Commit**

```bash
git add .kaizen/marketplace.json harnesses/openai-compatible.json
git commit -m "chore: register llm-axioms@0.1.0 + llm-contracts@0.3.0 in marketplace + harness"
```

---

## Task 14: Local deploy + smoke test

**Files:**
- None (deploys to `~/.kaizen/marketplaces/official/plugins/`)

- [ ] **Step 1: Deploy `llm-contracts@0.3.0`**

```bash
PLUGIN=llm-contracts
VERSION=0.3.0
INSTALL_DIR=~/.kaizen/marketplaces/official/plugins/${PLUGIN}@${VERSION}
mkdir -p "$INSTALL_DIR/dist"
(cd plugins/$PLUGIN && bun build --target=bun --outfile=dist/index.js index.ts)
rsync -a --exclude='node_modules' --exclude='dist' plugins/$PLUGIN/ "$INSTALL_DIR/"
cp plugins/$PLUGIN/dist/index.js "$INSTALL_DIR/dist/index.js"
```

Expected: `bun build` outputs nothing (clean build); `rsync` and `cp` exit 0.

- [ ] **Step 2: Deploy `llm-axioms@0.1.0`**

```bash
PLUGIN=llm-axioms
VERSION=0.1.0
INSTALL_DIR=~/.kaizen/marketplaces/official/plugins/${PLUGIN}@${VERSION}
mkdir -p "$INSTALL_DIR/dist"
(cd plugins/$PLUGIN && bun build --target=bun --outfile=dist/index.js index.ts)
rsync -a --exclude='node_modules' --exclude='dist' plugins/$PLUGIN/ "$INSTALL_DIR/"
cp plugins/$PLUGIN/dist/index.js "$INSTALL_DIR/dist/index.js"
```

Expected: same as above.

- [ ] **Step 3: Verify bundle does not reference `memory:store`**

```bash
grep -c '"memory:store"' ~/.kaizen/marketplaces/official/plugins/llm-axioms@0.1.0/dist/index.js
```

Expected: `0`. (Invariant from the spec: `llm-axioms` does not depend on memory.)

- [ ] **Step 4: Smoke-test the harness boot**

```bash
kaizen --harness ./harnesses/openai-compatible.json --validate
```

Expected: harness validates; the line listing loaded plugins includes `llm-axioms@0.1.0` and `llm-contracts@0.3.0`.

If `--validate` is not a supported flag, instead start the harness briefly and confirm the splash/log shows the plugin loaded, then exit.

- [ ] **Step 5: Manually exercise the slash commands**

Start the harness:

```bash
kaizen --harness ./harnesses/openai-compatible.json
```

Run, in the TUI:

1. `/axioms:list` — expect "No axioms in this session."
2. Ask the model: "Record an axiom: `id=demo`, statement=`Tests should fail before they pass`, premise=`TDD requires red-then-green`, reasoning=`A passing test on first run may be vacuous`, scope=`testing discipline`." — model should call `axiom_record`.
3. `/axioms:list` — expect the new axiom to show.
4. `/axioms:show demo` — expect full detail.
5. `/axioms:clear` — expect "Cleared 1 axiom..."
6. `/axioms:list` — expect empty state again.

Expected: every step succeeds; the axioms section appears in the system prompt while populated (verify via `/prompt show` if that slash command is available in the harness, otherwise trust the unit tests).

- [ ] **Step 6: Strike the TODO entry**

Open `docs/TODO.md` and remove the item about the axiom registry plugin (or annotate it as shipped, matching the precedent of `895ad92 docs(todo): llm-config plugin shipped`).

- [ ] **Step 7: Commit the TODO update**

```bash
git add docs/TODO.md
git commit -m "docs(todo): llm-axioms plugin shipped"
```

- [ ] **Step 8: Push (optional, only if user requests)**

```bash
git push
```

---

## Acceptance criteria

- [ ] `bun test` passes for every plugin in the workspace, including all `llm-axioms` suites.
- [ ] `kaizen plugin validate plugins/llm-axioms` passes.
- [ ] Harness boots with `llm-axioms@0.1.0` + `llm-contracts@0.3.0` loaded.
- [ ] Manual smoke test (Task 14 Step 5) passes end-to-end.
- [ ] `grep memory:store` against `dist/index.js` returns 0.
- [ ] `docs/TODO.md` no longer references the unbuilt axiom plugin.

## Architecture acid test

After deploy, a developer can:

1. Edit `plugins/llm-axioms/index.ts` to swap `ctx.provideService` for a stub that returns `{ list: () => [], get: () => null, record: async () => { throw new Error("stub"); }, ... }`.
2. Run `bun test plugins/llm-tools-registry` (or any other consumer) — still passes; no consumer depends on `llm-axioms`'s implementation, only on the contract.
3. Or: remove `llm-axioms` from the harness manifest and add a tiny replacement plugin that calls `ctx.provideService("axioms:registry", stub)`. Harness still boots; tools/sections specific to `llm-axioms` are simply absent.

This is the contract-not-implementation boundary the architecture doc demands.
