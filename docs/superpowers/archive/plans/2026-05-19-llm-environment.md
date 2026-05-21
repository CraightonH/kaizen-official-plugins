# llm-environment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a new Kaizen plugin `llm-environment@0.1.0` that registers an `Environment` system-prompt section containing cwd, host platform, and current git branch — built on the existing `prompt:registry` / `slash:registry` / `tools:registry` contracts, with explicit refresh and three kill switches.

**Architecture:** Mirror `llm-system-prompt`'s module map: one lifecycle file that touches `ctx`, one pure factory (`environment.ts`) owning the snapshot, plus stateless `slash.ts` and `tool.ts` factories. Snapshot is captured once at `setup()` and refreshed only via `/env:refresh` or the `environment_refresh` tool. Git detection is filesystem-only (no shell-out).

**Tech Stack:** TypeScript, Bun, `bun:test`, Kaizen plugin API v3.0.0, workspace `llm-contracts`.

**Reference spec:** `docs/superpowers/specs/2026-05-19-llm-environment-design.md`

---

## File Structure

All paths relative to repo root.

**Create:**
- `plugins/llm-environment/package.json` — workspace manifest
- `plugins/llm-environment/tsconfig.json` — copied from `llm-axioms`
- `plugins/llm-environment/public.d.ts` — `EnvironmentSnapshot`, `GitSnapshot` types
- `plugins/llm-environment/environment.ts` — pure snapshot logic (the only stateful module)
- `plugins/llm-environment/slash.ts` — pure slash-handler factory
- `plugins/llm-environment/tool.ts` — pure tool-handler factory
- `plugins/llm-environment/index.ts` — lifecycle (only file touching `ctx`)
- `plugins/llm-environment/README.md` — user contract
- `plugins/llm-environment/CLAUDE.md` — agent instructions (module map, invariants, local deploy)
- `plugins/llm-environment/test/environment.test.ts`
- `plugins/llm-environment/test/slash.test.ts`
- `plugins/llm-environment/test/tool.test.ts`
- `plugins/llm-environment/test/index.test.ts`
- `plugins/llm-environment/test/fixtures/git-branch/.git/HEAD`
- `plugins/llm-environment/test/fixtures/git-branch/.git/refs/heads/main`
- `plugins/llm-environment/test/fixtures/git-detached/.git/HEAD`
- `plugins/llm-environment/test/fixtures/git-worktree/.git` *(file containing `gitdir: …`)*
- `plugins/llm-environment/test/fixtures/git-malformed/.git/HEAD`
- `plugins/llm-environment/test/fixtures/non-git/.gitkeep`

**Modify:**
- `.kaizen/marketplace.json` — add `llm-environment` catalog entry
- `harnesses/openai-compatible.json` — add `"official/llm-environment@0.1.0"` to `.plugins[]`

---

### Task 1: Scaffold plugin (manifest, tsconfig, public types)

**Files:**
- Create: `plugins/llm-environment/package.json`
- Create: `plugins/llm-environment/tsconfig.json`
- Create: `plugins/llm-environment/public.d.ts`

- [ ] **Step 1: Create `plugins/llm-environment/package.json`**

```json
{
  "name": "llm-environment",
  "version": "0.1.0",
  "description": "Surfaces working directory, host platform, and git context in the system prompt for the openai-compatible harness.",
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

- [ ] **Step 2: Create `plugins/llm-environment/tsconfig.json`**

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

- [ ] **Step 3: Create `plugins/llm-environment/public.d.ts`**

```typescript
export interface GitSnapshot {
  isRepo: boolean;
  branch?: string;
}

export interface EnvironmentSnapshot {
  cwd: string;
  platform: string;
  git: GitSnapshot;
}
```

- [ ] **Step 4: Install workspace**

Run: `bun install`
Expected: completes without error; `plugins/llm-environment` is now linked into the workspace.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-environment/package.json plugins/llm-environment/tsconfig.json plugins/llm-environment/public.d.ts bun.lock
git commit -m "feat(llm-environment): scaffold plugin manifest and public types"
```

---

### Task 2: Build fixtures helper (programmatic, not static)

**Files:**
- Create: `plugins/llm-environment/test/fixtures.ts`

**Why programmatic:** git refuses to track any path containing `.git/` (security invariant in `update-index`). Static fixtures committed under `test/fixtures/git-branch/.git/HEAD` are silently dropped on commit. Build the same tree in a tmpdir at test time instead.

- [ ] **Step 1: Write `plugins/llm-environment/test/fixtures.ts`**

```typescript
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface FixtureSet {
  gitBranch: string;
  gitDetached: string;
  gitWorktree: string;
  gitMalformed: string;
  nonGit: string;
}

/**
 * Build the git-detection fixture tree under `root`. Returns the absolute
 * paths of each fixture's working-directory root (the dir that callers will
 * pass as `cwd` to captureEnvironment).
 *
 * These cannot be checked in as static files because git refuses to track
 * any path under a `.git/` directory. They are built per-test instead.
 */
export function buildFixtures(root: string): FixtureSet {
  const gitBranch = join(root, "git-branch");
  const gitDetached = join(root, "git-detached");
  const gitWorktree = join(root, "git-worktree");
  const gitMalformed = join(root, "git-malformed");
  const nonGit = join(root, "non-git");

  mkdirSync(join(gitBranch, ".git", "refs", "heads"), { recursive: true });
  writeFileSync(join(gitBranch, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(gitBranch, ".git", "refs", "heads", "main"), "");

  mkdirSync(join(gitDetached, ".git"), { recursive: true });
  writeFileSync(
    join(gitDetached, ".git", "HEAD"),
    "1234567890abcdef1234567890abcdef12345678\n",
  );

  mkdirSync(join(gitWorktree, ".realgit", "refs", "heads"), { recursive: true });
  writeFileSync(join(gitWorktree, ".git"), "gitdir: .realgit\n");
  writeFileSync(join(gitWorktree, ".realgit", "HEAD"), "ref: refs/heads/feature\n");
  writeFileSync(join(gitWorktree, ".realgit", "refs", "heads", "feature"), "");

  mkdirSync(join(gitMalformed, ".git"), { recursive: true });
  writeFileSync(join(gitMalformed, ".git", "HEAD"), " \n");

  mkdirSync(nonGit, { recursive: true });

  return { gitBranch, gitDetached, gitWorktree, gitMalformed, nonGit };
}
```

- [ ] **Step 2: Smoke-test the helper**

```bash
cd plugins/llm-environment
cat > /tmp/verify-fixtures.ts <<'EOF'
import { mkdtempSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFixtures } from "./test/fixtures.ts";
const root = mkdtempSync(join(tmpdir(), "llm-env-fixtures-"));
try {
  const f = buildFixtures(root);
  console.log("branch HEAD:", JSON.stringify(readFileSync(join(f.gitBranch, ".git/HEAD"), "utf8")));
  console.log("detached HEAD:", JSON.stringify(readFileSync(join(f.gitDetached, ".git/HEAD"), "utf8")));
  console.log("worktree .git is file:", statSync(join(f.gitWorktree, ".git")).isFile());
  console.log("worktree .realgit HEAD:", JSON.stringify(readFileSync(join(f.gitWorktree, ".realgit/HEAD"), "utf8")));
  console.log("malformed bytes:", Array.from(readFileSync(join(f.gitMalformed, ".git/HEAD"))));
  console.log("non-git exists:", statSync(f.nonGit).isDirectory());
} finally { rmSync(root, { recursive: true, force: true }); }
EOF
bun /tmp/verify-fixtures.ts
rm /tmp/verify-fixtures.ts
```

Expected output (each on its own line):
- `branch HEAD: "ref: refs/heads/main\n"`
- `detached HEAD: "1234567890abcdef1234567890abcdef12345678\n"`
- `worktree .git is file: true`
- `worktree .realgit HEAD: "ref: refs/heads/feature\n"`
- `malformed bytes: [ 32, 10 ]`
- `non-git exists: true`

- [ ] **Step 3: Commit**

```bash
git add plugins/llm-environment/test/fixtures.ts
git commit -m "test(llm-environment): programmatic git-detection fixtures helper"
```

---

### Task 3: Implement `environment.ts` — snapshot capture and render

**Files:**
- Create: `plugins/llm-environment/test/environment.test.ts`
- Create: `plugins/llm-environment/environment.ts`

- [ ] **Step 1: Write the failing test file**

Path: `plugins/llm-environment/test/environment.test.ts`
Content:

```typescript
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureEnvironment } from "../environment.ts";
import { buildFixtures, type FixtureSet } from "./fixtures.ts";

let root: string;
let f: FixtureSet;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "llm-env-test-"));
  f = buildFixtures(root);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("captureEnvironment", () => {
  it("registers section with id, priority 30, and title", async () => {
    const handle = captureEnvironment({ cwd: f.nonGit });
    await handle.refresh();
    expect(handle.section.id).toBe("llm-environment:env");
    expect(handle.section.priority).toBe(30);
    expect(handle.section.title).toBe("Environment");
  });

  it("renders cwd and platform; omits git line when not a repo", async () => {
    const handle = captureEnvironment({ cwd: f.nonGit });
    await handle.refresh();
    const body = await handle.section.render();
    expect(body).toContain(`- Working directory: ${f.nonGit}`);
    expect(body).toContain(`- Platform: ${process.platform}`);
    expect(body).not.toContain("Git repo:");
  });

  it("renders branch when HEAD points to a ref", async () => {
    const handle = captureEnvironment({ cwd: f.gitBranch });
    await handle.refresh();
    expect(await handle.section.render()).toContain("- Git repo: main");
  });

  it("renders 'yes' when HEAD is detached", async () => {
    const handle = captureEnvironment({ cwd: f.gitDetached });
    await handle.refresh();
    const body = await handle.section.render();
    expect(body).toContain("- Git repo: yes");
    expect(body).not.toContain("- Git repo: main");
  });

  it("follows .git-as-file worktree pointer", async () => {
    const handle = captureEnvironment({ cwd: f.gitWorktree });
    await handle.refresh();
    expect(await handle.section.render()).toContain("- Git repo: feature");
  });

  it("treats malformed .git/HEAD as non-repo without throwing", async () => {
    const handle = captureEnvironment({ cwd: f.gitMalformed });
    await handle.refresh();
    expect(await handle.section.render()).not.toContain("Git repo:");
  });

  it("walks up to find .git in an ancestor directory", async () => {
    // gitBranch contains .git; descend one level and confirm walk-up resolves.
    const handle = captureEnvironment({ cwd: join(f.gitBranch, "nonexistent-subdir", "..") });
    await handle.refresh();
    expect(await handle.section.render()).toContain("- Git repo: main");
  });

  it("returns empty string when KAIZEN_ENVIRONMENT_DISABLE=1", async () => {
    const handle = captureEnvironment({
      cwd: f.gitBranch,
      env: { KAIZEN_ENVIRONMENT_DISABLE: "1" },
    });
    await handle.refresh();
    expect(await handle.section.render()).toBe("");
  });

  it("refresh() picks up a branch change", async () => {
    const headPath = join(f.gitBranch, ".git", "HEAD");
    writeFileSync(headPath, "ref: refs/heads/main\n");
    const handle = captureEnvironment({ cwd: f.gitBranch });
    await handle.refresh();
    expect(await handle.section.render()).toContain("- Git repo: main");

    writeFileSync(headPath, "ref: refs/heads/feature-x\n");
    await handle.refresh();
    expect(await handle.section.render()).toContain("- Git repo: feature-x");
  });
});
```

- [ ] **Step 2: Run the tests — expect every case to fail with "module not found"**

```bash
cd plugins/llm-environment && bun test test/environment.test.ts
```

Expected: failure — `Cannot find module "../environment.ts"`.

- [ ] **Step 3: Implement `environment.ts`**

Path: `plugins/llm-environment/environment.ts`
Content:

```typescript
import { existsSync, readFileSync, statSync } from "node:fs";
import { release } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { EnvironmentSnapshot, GitSnapshot } from "./public";

export interface CaptureOptions {
  cwd: string;
  env?: Record<string, string | undefined>;
}

export interface SectionLike {
  id: string;
  priority: number;
  title: string;
  render(): Promise<string>;
}

export interface EnvironmentHandle {
  section: SectionLike;
  refresh(): Promise<void>;
}

const SECTION_ID = "llm-environment:env";
const SECTION_PRIORITY = 30;
const SECTION_TITLE = "Environment";

function detectGit(startCwd: string): GitSnapshot {
  try {
    let dir = resolve(startCwd);
    // Walk up to filesystem root.
    while (true) {
      const candidate = join(dir, ".git");
      if (existsSync(candidate)) {
        return readGitAt(candidate);
      }
      const parent = dirname(dir);
      if (parent === dir) return { isRepo: false };
      dir = parent;
    }
  } catch {
    return { isRepo: false };
  }
}

function readGitAt(gitPath: string): GitSnapshot {
  try {
    const st = statSync(gitPath);
    let realGitDir = gitPath;
    if (st.isFile()) {
      const pointer = readFileSync(gitPath, "utf8").trim();
      const match = pointer.match(/^gitdir:\s*(.+)$/);
      if (!match) return { isRepo: false };
      const target = match[1]!.trim();
      realGitDir = isAbsolute(target) ? target : resolve(dirname(gitPath), target);
    } else if (!st.isDirectory()) {
      return { isRepo: false };
    }
    const headPath = join(realGitDir, "HEAD");
    if (!existsSync(headPath)) return { isRepo: true };
    const head = readFileSync(headPath, "utf8").trim();
    if (head.length === 0) return { isRepo: true };
    const refMatch = head.match(/^ref:\s*refs\/heads\/(.+)$/);
    if (refMatch) return { isRepo: true, branch: refMatch[1]!.trim() };
    // Detached HEAD or unparseable — still a repo, no branch.
    return { isRepo: true };
  } catch {
    return { isRepo: false };
  }
}

export function captureEnvironment(opts: CaptureOptions): EnvironmentHandle {
  const env = opts.env ?? process.env;
  let snapshot: EnvironmentSnapshot = {
    cwd: opts.cwd,
    platform: `${process.platform} (${release()})`,
    git: { isRepo: false },
  };

  async function refresh(): Promise<void> {
    snapshot = {
      cwd: opts.cwd,
      platform: `${process.platform} (${release()})`,
      git: detectGit(opts.cwd),
    };
  }

  function render(): string {
    if (env.KAIZEN_ENVIRONMENT_DISABLE === "1") return "";
    const lines: string[] = [
      `- Working directory: ${snapshot.cwd}`,
      `- Platform: ${snapshot.platform}`,
    ];
    if (snapshot.git.isRepo) {
      lines.push(`- Git repo: ${snapshot.git.branch ?? "yes"}`);
    }
    return lines.join("\n");
  }

  return {
    section: {
      id: SECTION_ID,
      priority: SECTION_PRIORITY,
      title: SECTION_TITLE,
      render: async () => render(),
    },
    refresh,
  };
}
```

- [ ] **Step 4: Run the tests — expect all to pass**

```bash
cd plugins/llm-environment && bun test test/environment.test.ts
```

Expected: all 9 tests pass.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-environment/environment.ts plugins/llm-environment/test/environment.test.ts
git commit -m "feat(llm-environment): capture cwd/platform/git snapshot with render()"
```

---

### Task 4: Implement `slash.ts` — `/env:refresh` handler factory

**Files:**
- Create: `plugins/llm-environment/test/slash.test.ts`
- Create: `plugins/llm-environment/slash.ts`

- [ ] **Step 1: Write the failing test**

Path: `plugins/llm-environment/test/slash.test.ts`
Content:

```typescript
import { describe, expect, it } from "bun:test";
import { makeEnvSlashHandlers } from "../slash.ts";

function makeFakeSlashCtx() {
  const printed: string[] = [];
  return {
    ctx: {
      print: (s: string) => { printed.push(s); },
    },
    printed,
  };
}

describe("makeEnvSlashHandlers", () => {
  it("invokes refresh and prints confirmation", async () => {
    let calls = 0;
    const { refresh } = makeEnvSlashHandlers({
      refresh: async () => { calls += 1; },
    });
    const fake = makeFakeSlashCtx();
    await refresh.handler({ args: "", argv: [] }, fake.ctx as never);
    expect(calls).toBe(1);
    expect(fake.printed).toEqual(["environment refreshed"]);
  });

  it("exposes the slash manifest", () => {
    const { refresh } = makeEnvSlashHandlers({ refresh: async () => {} });
    expect(refresh.name).toBe("env:refresh");
    expect(refresh.description).toMatch(/refresh/i);
  });
});
```

- [ ] **Step 2: Run — expect module-not-found**

```bash
bun test test/slash.test.ts
```

- [ ] **Step 3: Implement `slash.ts`**

Path: `plugins/llm-environment/slash.ts`
Content:

```typescript
type SlashContext = { print(message: string): void };
type SlashInvocation = { args: string; argv: string[] };
type SlashHandler = (invocation: SlashInvocation, ctx: SlashContext) => Promise<void> | void;

export interface EnvSlashOptions {
  refresh: () => Promise<void>;
}

export interface EnvSlashEntry {
  name: string;
  description: string;
  handler: SlashHandler;
}

export function makeEnvSlashHandlers(opts: EnvSlashOptions): { refresh: EnvSlashEntry } {
  return {
    refresh: {
      name: "env:refresh",
      description: "Re-capture the working-directory / platform / git snapshot used in the system prompt.",
      handler: async (_inv, ctx) => {
        await opts.refresh();
        ctx.print("environment refreshed");
      },
    },
  };
}
```

- [ ] **Step 4: Run — expect pass**

```bash
bun test test/slash.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-environment/slash.ts plugins/llm-environment/test/slash.test.ts
git commit -m "feat(llm-environment): /env:refresh slash handler"
```

---

### Task 5: Implement `tool.ts` — `environment_refresh` tool factory

**Files:**
- Create: `plugins/llm-environment/test/tool.test.ts`
- Create: `plugins/llm-environment/tool.ts`

- [ ] **Step 1: Write the failing test**

Path: `plugins/llm-environment/test/tool.test.ts`
Content:

```typescript
import { describe, expect, it } from "bun:test";
import { makeEnvToolHandlers, ENVIRONMENT_REFRESH_SCHEMA } from "../tool.ts";

describe("makeEnvToolHandlers", () => {
  it("schema name, description, tags, and empty parameters", () => {
    expect(ENVIRONMENT_REFRESH_SCHEMA.name).toBe("environment_refresh");
    expect(ENVIRONMENT_REFRESH_SCHEMA.description).toMatch(/snapshot/i);
    expect(ENVIRONMENT_REFRESH_SCHEMA.tags).toEqual(["environment", "diagnostic", "synthetic"]);
    expect(ENVIRONMENT_REFRESH_SCHEMA.parameters).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
  });

  it("handler invokes refresh and returns ok payload", async () => {
    let calls = 0;
    const { refresh } = makeEnvToolHandlers({
      refresh: async () => { calls += 1; },
    });
    const result = await refresh.handler({}, {} as never);
    expect(calls).toBe(1);
    expect(result).toEqual({ ok: true, message: "environment refreshed" });
  });
});
```

- [ ] **Step 2: Run — expect failure**

```bash
bun test test/tool.test.ts
```

- [ ] **Step 3: Implement `tool.ts`**

Path: `plugins/llm-environment/tool.ts`
Content:

```typescript
import type { ToolSchema, ToolHandler } from "llm-contracts/public";

export interface EnvToolOptions {
  refresh: () => Promise<void>;
}

export interface EnvToolEntry {
  schema: ToolSchema;
  handler: ToolHandler;
}

export const ENVIRONMENT_REFRESH_SCHEMA: ToolSchema = {
  name: "environment_refresh",
  description:
    "Re-capture the working-directory / platform / git snapshot used in the system prompt. Has filesystem side effects — call only when explicitly asked, or after the user has cd'd or switched branches.",
  parameters: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  tags: ["environment", "diagnostic", "synthetic"],
};

export function makeEnvToolHandlers(opts: EnvToolOptions): { refresh: EnvToolEntry } {
  return {
    refresh: {
      schema: ENVIRONMENT_REFRESH_SCHEMA,
      handler: async () => {
        await opts.refresh();
        return { ok: true, message: "environment refreshed" };
      },
    },
  };
}
```

- [ ] **Step 4: Run — expect pass**

```bash
bun test test/tool.test.ts
```

If the `ToolSchema` type does not have a `tags` field, drop the explicit `: ToolSchema` annotation on the constant and let TypeScript infer the shape; the registry accepts the extra field at runtime (`llm-skills/tool.ts` does the same).

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-environment/tool.ts plugins/llm-environment/test/tool.test.ts
git commit -m "feat(llm-environment): environment_refresh tool factory"
```

---

### Task 6: Wire lifecycle in `index.ts`

**Files:**
- Create: `plugins/llm-environment/test/index.test.ts`
- Create: `plugins/llm-environment/index.ts`

- [ ] **Step 1: Write the failing test**

Path: `plugins/llm-environment/test/index.test.ts`
Content:

```typescript
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../index.ts";
import { buildFixtures, type FixtureSet } from "./fixtures.ts";

let fixtureRoot: string;
let fixtures: FixtureSet;

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), "llm-env-index-"));
  fixtures = buildFixtures(fixtureRoot);
});

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

interface SectionReg {
  id: string;
  priority: number;
  title?: string;
  render(): Promise<string> | string;
  generationBumps: number;
  unregistered: boolean;
}

interface SlashReg {
  manifest: { name: string; description: string; source?: string };
  unregistered: boolean;
}

interface ToolReg {
  schema: { name: string };
  source: { kind: string };
  unregistered: boolean;
}

function makeFakeCtx(opts: { slash?: boolean; tools?: boolean; cwd?: string; env?: Record<string, string | undefined> } = {}) {
  const slashOn = opts.slash ?? true;
  const toolsOn = opts.tools ?? true;
  const sections: SectionReg[] = [];
  const slashRegs: SlashReg[] = [];
  const toolRegs: ToolReg[] = [];
  const logs: string[] = [];

  const promptRegistry = {
    register(section: { id: string; priority: number; title?: string; render(): Promise<string> | string }) {
      const reg: SectionReg = { ...section, generationBumps: 0, unregistered: false };
      sections.push(reg);
      return {
        bumpGeneration: () => { reg.generationBumps += 1; },
        unregister: () => { reg.unregistered = true; },
      };
    },
  };

  const slashRegistry = {
    register(manifest: { name: string; description: string; source?: string }, _h: unknown) {
      const r: SlashReg = { manifest, unregistered: false };
      slashRegs.push(r);
      return () => { r.unregistered = true; };
    },
    get: () => undefined,
    list: () => [],
  };

  const toolsRegistry = {
    register: () => () => {},
    registerWith(reg: { schema: { name: string }; handler: unknown; source: { kind: string } }) {
      const r: ToolReg = { schema: reg.schema, source: reg.source, unregistered: false };
      toolRegs.push(r);
      return () => { r.unregistered = true; };
    },
    list: () => [],
    listRegistrations: () => [],
    invoke: async () => undefined,
  };

  const ctx = {
    cwd: opts.cwd ?? fixtures.nonGit,
    env: opts.env ?? {},
    log: (m: string) => { logs.push(m); },
    provideService: () => {},
    consumeService: () => {},
    useService: (n: string) => {
      if (n === "prompt:registry") return promptRegistry;
      if (n === "slash:registry") {
        if (slashOn) return slashRegistry;
        throw new Error("missing service slash:registry");
      }
      if (n === "tools:registry") {
        if (toolsOn) return toolsRegistry;
        throw new Error("missing service tools:registry");
      }
      throw new Error(`missing service ${n}`);
    },
    emit: async () => {},
    on: () => {},
  };

  return { ctx: ctx as never, sections, slashRegs, toolRegs, logs };
}

describe("llm-environment plugin", () => {
  it("registers section at priority 30 with title Environment", async () => {
    const f = makeFakeCtx();
    await plugin.setup!(f.ctx);
    expect(f.sections.length).toBe(1);
    expect(f.sections[0]!.id).toBe("llm-environment:env");
    expect(f.sections[0]!.priority).toBe(30);
    expect(f.sections[0]!.title).toBe("Environment");
  });

  it("registers /env:refresh when slash:registry is present", async () => {
    const f = makeFakeCtx({ slash: true });
    await plugin.setup!(f.ctx);
    expect(f.slashRegs.length).toBe(1);
    expect(f.slashRegs[0]!.manifest.name).toBe("env:refresh");
  });

  it("registers environment_refresh tool when tools:registry is present", async () => {
    const f = makeFakeCtx({ tools: true });
    await plugin.setup!(f.ctx);
    expect(f.toolRegs.length).toBe(1);
    expect(f.toolRegs[0]!.schema.name).toBe("environment_refresh");
    expect(f.toolRegs[0]!.source.kind).toBe("local");
  });

  it("survives when slash:registry and tools:registry are absent", async () => {
    const f = makeFakeCtx({ slash: false, tools: false });
    await plugin.setup!(f.ctx);
    expect(f.sections.length).toBe(1);
    expect(f.slashRegs.length).toBe(0);
    expect(f.toolRegs.length).toBe(0);
  });

  it("stop() unregisters section, slash, and tool; second call is a no-op", async () => {
    const f = makeFakeCtx();
    await plugin.setup!(f.ctx);
    await plugin.stop!();
    expect(f.sections[0]!.unregistered).toBe(true);
    expect(f.slashRegs[0]!.unregistered).toBe(true);
    expect(f.toolRegs[0]!.unregistered).toBe(true);
    // Second call must not throw.
    await plugin.stop!();
  });
});
```

- [ ] **Step 2: Run — expect module-not-found**

```bash
bun test test/index.test.ts
```

- [ ] **Step 3: Implement `index.ts`**

Path: `plugins/llm-environment/index.ts`
Content:

```typescript
import type { KaizenPlugin, PluginContext } from "kaizen/types";
import type { SystemPromptService, SlashRegistryService } from "llm-contracts/public";
import type { ToolsRegistryService } from "llm-contracts/public";
import { captureEnvironment } from "./environment.ts";
import { makeEnvSlashHandlers } from "./slash.ts";
import { makeEnvToolHandlers } from "./tool.ts";

function safeUseService<T>(ctx: PluginContext, name: string): T | undefined {
  try {
    return ctx.useService<T>(name);
  } catch {
    return undefined;
  }
}

type RuntimeHints = { cwd?: string; env?: Record<string, string | undefined> };

let teardown: Array<() => void> = [];

const plugin: KaizenPlugin = {
  name: "llm-environment",
  apiVersion: "3.0.0",
  permissions: { tier: "unscoped" },
  services: {
    provides: [],
    // tools:registry is functionally optional but listed so kaizen orders this
    // plugin after the registry's provider when one exists. prompt:registry is
    // required for the section to land; slash:registry is best-effort.
    consumes: ["tools:registry"],
  },

  async setup(ctx) {
    const runtime = ctx as PluginContext & RuntimeHints;
    const cwd = typeof runtime.cwd === "string" && runtime.cwd.length > 0 ? runtime.cwd : process.cwd();
    const env = runtime.env ?? process.env;

    const env_ = captureEnvironment({ cwd, env });
    await env_.refresh();

    const prompt = ctx.useService<SystemPromptService>("prompt:registry");
    const sectionHandle = prompt.register(env_.section);
    teardown.push(() => sectionHandle.unregister());

    const refresh = async (): Promise<void> => {
      await env_.refresh();
      sectionHandle.bumpGeneration();
    };

    const slashRegistry = safeUseService<SlashRegistryService>(ctx, "slash:registry");
    if (slashRegistry) {
      const { refresh: slashRefresh } = makeEnvSlashHandlers({ refresh });
      const unregister = slashRegistry.register(
        { name: slashRefresh.name, description: slashRefresh.description, source: "plugin" },
        slashRefresh.handler,
      );
      // SlashRegistryService.register may return void in some runtimes — guard.
      if (typeof unregister === "function") teardown.push(unregister);
    } else {
      ctx.log("[llm-environment] slash:registry not available; /env:refresh not registered");
    }

    const tools = safeUseService<ToolsRegistryService>(ctx, "tools:registry");
    if (tools) {
      const { refresh: toolRefresh } = makeEnvToolHandlers({ refresh });
      const unregister = tools.registerWith({
        schema: toolRefresh.schema,
        handler: toolRefresh.handler,
        source: { kind: "local" },
      });
      teardown.push(unregister);
    } else {
      ctx.log("[llm-environment] tools:registry not available; environment_refresh not registered");
    }
  },

  async stop() {
    const handles = teardown;
    teardown = [];
    for (const fn of handles) {
      try { fn(); } catch { /* idempotent */ }
    }
  },
};

export default plugin;
```

- [ ] **Step 4: Run all tests**

```bash
cd plugins/llm-environment && bun test
```

Expected: all tests pass (environment.test.ts + slash.test.ts + tool.test.ts + index.test.ts).

If the `SlashRegistryService.register` signature in the contract returns `void` rather than `() => void`, the `typeof unregister === "function"` guard handles both. If TypeScript complains, cast the return at the call site: `const unregister = slashRegistry.register(...) as (() => void) | undefined;`.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-environment/index.ts plugins/llm-environment/test/index.test.ts
git commit -m "feat(llm-environment): lifecycle wiring and best-effort slash/tool registration"
```

---

### Task 7: Author plugin docs (`README.md`, `CLAUDE.md`)

**Files:**
- Create: `plugins/llm-environment/README.md`
- Create: `plugins/llm-environment/CLAUDE.md`

- [ ] **Step 1: Write `README.md`**

Path: `plugins/llm-environment/README.md`
Content:

```markdown
# llm-environment

Adds an `Environment` section to the assembled system prompt for the
openai-compatible harness. Lets the LLM see the current working directory,
host platform, and git branch.

## Rendered output

```
## Environment

- Working directory: /Users/you/projects/app
- Platform: darwin (Darwin 25.4.0)
- Git repo: main
```

In a non-git directory, the `Git repo:` line is omitted. In a detached-HEAD
state, the line reads `Git repo: yes`.

## Slash command

- `/env:refresh` — re-captures the snapshot. Use after `cd` or branch checkout.

## Tool

When `tools:registry` is present, the plugin registers:

- `environment_refresh` — re-captures the snapshot. Tagged
  `["environment", "diagnostic", "synthetic"]`.

## Kill switches

Three layers, in increasing finality:

1. `KAIZEN_ENVIRONMENT_DISABLE=1` — the section renders empty and is dropped.
2. `prompt:disable llm-environment:env` — per-session toggle via the
   `llm-system-prompt` slash command.
3. Uninstall the plugin from the harness manifest.

## Future fields

The snapshot is the natural home for timezone, locale, and language hints;
none are shipped in v0.1.0.
```

- [ ] **Step 2: Write `CLAUDE.md`**

Path: `plugins/llm-environment/CLAUDE.md`
Content:

```markdown
# Working in `llm-environment`

Notes for agents editing this plugin. See `README.md` for the user contract.

## Module map

```
index.ts         Plugin lifecycle: captures snapshot at setup(), registers section at p=30,
                 best-effort registers /env:refresh and environment_refresh. Only file
                 touching `ctx`.
environment.ts   captureEnvironment({ cwd, env? }) → { section, refresh }. Pure logic.
                 Synchronous git detection (walks up for .git; reads HEAD directly).
                 No shell-out.
slash.ts         makeEnvSlashHandlers({ refresh }) → { refresh }. Stateless factory.
tool.ts          makeEnvToolHandlers({ refresh }) → { refresh }. Stateless factory.
                 Exports ENVIRONMENT_REFRESH_SCHEMA constant.
public.d.ts      EnvironmentSnapshot, GitSnapshot. No service is exported.
```

Boundaries:
- Only `index.ts` imports `kaizen/types` or touches `ctx`.
- `environment.ts` is the only stateful module. slash.ts and tool.ts are pure.
- Tests for each module live alongside in `test/` and run independently (`bun test`).

## Invariants

- **Snapshot is static between refresh calls.** `render()` is a synchronous
  cache read; do not add filesystem watchers.
- **`render()` never throws.** Git-detection failures are swallowed and
  surfaced as `git.isRepo = false`.
- **Empty render → section dropped.** `KAIZEN_ENVIRONMENT_DISABLE=1` returns
  `""`; the prompt registry drops empty sections.
- **No "Git repo: no" line.** When `isRepo === false`, the line is omitted
  entirely.
- **Detached HEAD renders `Git repo: yes`.** `git.branch` is `undefined`; the
  render falls back to `yes`.
- **No shell-out.** Git detection is filesystem-only — walk up for `.git`,
  read `HEAD`, follow `.git`-as-file worktree pointers once.
- **Teardown is idempotent.** `stop()` drains every handle; second call is a
  no-op.

## Adding a new field (e.g. timezone, locale)

1. Add the field to `EnvironmentSnapshot` in `public.d.ts`.
2. Populate it inside `refresh()` in `environment.ts`.
3. Append a render line in `render()`.
4. Add fixture-based tests in `test/environment.test.ts`.

The kill switches and refresh plumbing need no changes.

## Testing

```bash
cd plugins/llm-environment && bun test
```

Tests use `bun:test` only. Filesystem fixtures live under `test/fixtures/`.
Tests must not write to `~/.kaizen/` or any path outside the fixtures tree.

## Local deploy

The Kaizen runtime prefers the bundled `dist/index.js` over source. After
editing:

```bash
cd plugins/llm-environment
bun build --target=bun --outfile=dist/index.js index.ts
INSTALL_DIR=~/.kaizen/marketplaces/official/plugins/llm-environment@0.1.0
mkdir -p "$INSTALL_DIR"
rsync -a --exclude=node_modules --exclude=dist ./ "$INSTALL_DIR/"
cp dist/index.js "$INSTALL_DIR/dist/index.js"
```

If the harness manifest needs to pick up the new plugin, also sync the local
marketplace repo at `~/.kaizen/marketplaces/official/repo/`.
```

- [ ] **Step 3: Commit**

```bash
git add plugins/llm-environment/README.md plugins/llm-environment/CLAUDE.md
git commit -m "docs(llm-environment): README and CLAUDE.md"
```

---

### Task 8: Marketplace + harness wiring

**Files:**
- Modify: `.kaizen/marketplace.json`
- Modify: `harnesses/openai-compatible.json`

- [ ] **Step 1: Add marketplace entry**

In `.kaizen/marketplace.json`, find the `plugins` array (the same array containing the `llm-axioms` entry shown below) and add a new entry alongside it. Use this exact object:

```json
{
  "kind": "plugin",
  "name": "llm-environment",
  "description": "Surfaces working directory, host platform, and git context in the system prompt.",
  "categories": ["prompt", "environment"],
  "versions": [
    { "version": "0.1.0", "source": { "type": "file", "path": "plugins/llm-environment" } }
  ]
}
```

Insert it adjacent to `llm-axioms` to keep prompt-related plugins grouped.

- [ ] **Step 2: Validate JSON**

```bash
jq . .kaizen/marketplace.json > /dev/null && echo OK
```

Expected: `OK`.

- [ ] **Step 3: Add harness entry**

In `harnesses/openai-compatible.json`, append `"official/llm-environment@0.1.0"` to the `.plugins` array. A safe edit is to append it just after the existing system-prompt or axioms entries to keep prompt contributors grouped (order in this file does not affect render priority — `p=30` does).

- [ ] **Step 4: Validate JSON**

```bash
jq . harnesses/openai-compatible.json > /dev/null && echo OK
```

Expected: `OK`.

- [ ] **Step 5: Plugin validate**

```bash
kaizen plugin validate plugins/llm-environment
```

Expected: no errors. If the validator flags a missing field, fix in place (most likely candidates: `permissions.tier`, `apiVersion`, or an `exports` entry in `package.json`).

- [ ] **Step 6: Commit**

```bash
git add .kaizen/marketplace.json harnesses/openai-compatible.json
git commit -m "chore: register llm-environment in marketplace and openai-compatible harness"
```

---

### Task 9: Local deploy and smoke-test the rendered prompt

**Files:** none modified — verification only.

- [ ] **Step 1: Bundle the plugin**

```bash
cd plugins/llm-environment
bun build --target=bun --outfile=dist/index.js index.ts
```

Expected: `dist/index.js` is created.

- [ ] **Step 2: Sync into the local install dir**

```bash
INSTALL_DIR=~/.kaizen/marketplaces/official/plugins/llm-environment@0.1.0
mkdir -p "$INSTALL_DIR"
rsync -a --exclude=node_modules --exclude=dist ./ "$INSTALL_DIR/"
cp dist/index.js "$INSTALL_DIR/dist/index.js"
```

- [ ] **Step 3: Launch the harness from the local checkout**

From the repo root:

```bash
kaizen --harness ./harnesses/openai-compatible.json
```

- [ ] **Step 4: Confirm the section appears**

Inside the running harness, run:

```
/prompt:show
```

Expected: the assembled prompt contains a `## Environment` block between `identity` (p=10) and `## Methodology` / axioms (p=50), with three (or two, if not in a repo) bullet lines.

- [ ] **Step 5: Confirm the refresh path**

```
/env:refresh
```

Expected output: `environment refreshed`.

Re-run `/prompt:show`. The Environment block should still be present and the section generation will have bumped (the prompt body is re-assembled on next read).

- [ ] **Step 6: Confirm the kill switch**

Exit the harness, then:

```bash
KAIZEN_ENVIRONMENT_DISABLE=1 kaizen --harness ./harnesses/openai-compatible.json
```

Run `/prompt:show` — the `## Environment` block must be absent.

- [ ] **Step 7: Run the full plugin test suite one last time**

```bash
cd plugins/llm-environment && bun test
```

Expected: all tests pass.

- [ ] **Step 8: No commit**

Task 9 produces only build artifacts (`dist/`) which are committed in source form via the bundle convention some plugins follow, but per repo CLAUDE.md the source is authoritative and the `dist/` bundle is generated only into the install dir, not committed back into `plugins/llm-environment/`. Leave the working tree clean.

If you discover a fix needed during smoke-test, open a follow-up task — do not amend prior commits.

---

## Self-Review Notes

**Spec coverage** — every requirement in `docs/superpowers/specs/2026-05-19-llm-environment-design.md` is addressed:

| Spec requirement | Task |
|---|---|
| Section id `llm-environment:env`, priority 30, title `Environment` | T3, T6 |
| Snapshot fields (cwd, platform, git) | T3 |
| No shell-out for git detection | T3 |
| Static snapshot captured at setup() | T6 |
| `KAIZEN_ENVIRONMENT_DISABLE=1` kill switch | T3 |
| `prompt:disable` per-section toggle (provided by `llm-system-prompt`) | covered by integration in T6 (section is registered through the same registry) |
| `/env:refresh` slash command | T4, T6 |
| `environment_refresh` tool with three tags | T5, T6 |
| Tool source `"local"` | T6 |
| Teardown drains all handles, idempotent | T6 |
| Git-line omitted when not a repo | T3 |
| Detached HEAD renders `Git repo: yes` | T3 |
| Marketplace + harness entries | T8 |
| Local-deploy verification | T9 |

**Placeholder scan:** no TBDs, no "implement appropriately", every code step shows the full code.

**Type consistency:**
- `captureEnvironment` returns `EnvironmentHandle { section, refresh }` — used the same way in `index.ts`.
- `makeEnvSlashHandlers({ refresh }) → { refresh: EnvSlashEntry }` — consumed in `index.ts`.
- `makeEnvToolHandlers({ refresh }) → { refresh: EnvToolEntry }` — consumed in `index.ts`.
- `ENVIRONMENT_REFRESH_SCHEMA.name === "environment_refresh"` — asserted in tool.test.ts and used unchanged in index.test.ts.
- Slash manifest name `env:refresh` — defined in slash.ts, asserted in slash.test.ts and index.test.ts.
- Section id, priority, title constants live only in `environment.ts` and are asserted in both `environment.test.ts` and `index.test.ts`.
