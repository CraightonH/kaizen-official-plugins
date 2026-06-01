# llm-workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `llm-workflow` kaizen plugin: a sandboxed Bun Worker engine that runs CC-shaped workflow scripts (top-level statements, `export const meta` literal, primitives `agent`/`parallel`/`pipeline`/`phase`/`log`/`workflow` as implicit globals), backed by `driver:run-conversation` for subagent calls. Exposes the `Workflow` tool, `/workflows:run`/`list`/`get` slash commands, and an on-disk registry under `~/.kaizen/workflows/*.ts` and `<cwd>/.kaizen/workflows/*.ts`.

**Architecture:** New plugin at `plugins/llm-workflow`. Adds the `workflow:registry` contract to `llm-contracts` and `workflow:*` events to `llm-events` VOCAB. Worker host (`sandbox-host.ts`) spawns a Bun Worker per run; worker (`sandbox-entry.ts`) installs primitives as frozen globals, evaluates the script in an `AsyncFunction`, and RPCs `agent`/`log`/`phase`/`workflow`/`budgetRead` calls back to the host. `parallel` and `pipeline` are pure JS helpers in the worker (no host RPC). Host owns the semaphore (`min(16, cpu-2)`), lifetime cap (1000), budget (subscribes to `llm:done`), and event emission.

**Tech Stack:** Bun runtime, TypeScript (strict, `bun:test`), workspace deps via `workspace:*`. Pattern-matches `llm-agents` (registry+loader+slash+tool+prompt-section lifecycle) and `llm-codemode` (Bun Worker sandbox via `sandbox-host.ts` + `sandbox-entry.ts` + `rpc-types.ts`).

**Spec:** `docs/superpowers/specs/2026-05-28-llm-workflow-design.md`.

---

## File Structure

**Modified (existing plugins):**

| Path | Change |
|---|---|
| `plugins/llm-contracts/contracts/workflow-registry.ts` | NEW — contract types + CONTRACT_ID + DESCRIPTION |
| `plugins/llm-contracts/public.ts` | re-export `workflow-registry` types |
| `plugins/llm-contracts/index.ts` | `defineService("workflow:registry", ...)` |
| `plugins/llm-contracts/package.json` | version bump 0.5.0 → 0.6.0 |
| `plugins/llm-contracts/index.test.ts` | assert new defineService call |
| `plugins/llm-events/index.ts` | new VOCAB keys + `defineEvent` calls |
| `plugins/llm-contracts/contracts/events.ts` | extend `Vocab` interface |
| `plugins/llm-events/package.json` | version bump 0.7.0 → 0.8.0 |
| `plugins/llm-events/index.test.ts` | add new VOCAB literals to expected set |
| `.kaizen/marketplace.json` | new entry for `llm-workflow` 0.1.0 + new versions for `llm-contracts`/`llm-events` |
| `harnesses/local.json` | add `llm-workflow@0.1.0` to plugin list |

**Created (new plugin) under `plugins/llm-workflow/`:**

| File | Responsibility |
|---|---|
| `package.json` | workspace dep on llm-contracts/llm-events/llm-driver/llm-tools-registry, kaizen-config, llm-system-prompt |
| `tsconfig.json` | mirrors llm-agents' tsconfig |
| `README.md` | user-facing contract |
| `CLAUDE.md` | module map + invariants |
| `public.d.ts` | concrete error classes + config shape |
| `ambient.d.ts` | ambient global declarations for workflow authors (`declare const agent: ...`) |
| `index.ts` | plugin lifecycle: wire registry + tool + slash + status + prompt; only file touching `ctx` |
| `config.ts` | DEFAULT_CONFIG + CONFIG_SCHEMA |
| `errors.ts` | concrete error classes |
| `meta-parse.ts` | static AST extraction of `export const meta = {...}` pure literal |
| `rpc-types.ts` | host ↔ worker message shapes |
| `sandbox-host.ts` | spawn Worker, wire RPC dispatch, abort handling |
| `sandbox-entry.ts` | Worker entrypoint — installs frozen globals, runs script |
| `semaphore.ts` | concurrency cap + lifetime counter |
| `budget.ts` | `llm:done` subscriber → tokensSpent accumulator |
| `registry.ts` | in-memory registry handle (mirror of llm-agents shape) |
| `loader.ts` | file discovery from user + project dirs |
| `primitives/agent.ts` | host-side `agent()` impl — driver call + agents:registry overlay + budget |
| `primitives/parallel.ts` | worker-side helper source (string) |
| `primitives/pipeline.ts` | worker-side helper source (string) |
| `primitives/phase.ts` | host-side `phase()` + `log()` impls (emit events) |
| `primitives/workflow.ts` | host-side nested `workflow()` impl (shares RunContext) |
| `runner.ts` | one workflow run: orchestrates Worker, semaphore, budget, journal hooks |
| `engine.ts` | public engine — implements `WorkflowRegistryService` |
| `tool.ts` | Workflow tool schema + handler factory |
| `slash.ts` | `/workflows:run`, `/workflows:list`, `/workflows:get` handler factory |
| `status.ts` | status:item-update emitter |
| `test/*.test.ts` | unit tests |
| `test/integration/*.test.ts` | integration tests (real Worker) |
| `test/_helpers.ts` | shared test fakes (ctx, driver, registry, etc.) |

---

## Task 1: Add `workflow:registry` contract to llm-contracts

**Files:**
- Create: `plugins/llm-contracts/contracts/workflow-registry.ts`
- Modify: `plugins/llm-contracts/public.ts`
- Modify: `plugins/llm-contracts/index.ts`
- Modify: `plugins/llm-contracts/package.json` (version bump)
- Modify: `plugins/llm-contracts/index.test.ts` (assert defineService)

- [ ] **Step 1: Create the contract module**

`plugins/llm-contracts/contracts/workflow-registry.ts`:

```typescript
export interface WorkflowPhase {
  title: string;
  detail?: string;
  model?: string;
}

export interface WorkflowMeta {
  name: string;
  description: string;
  whenToUse?: string;
  phases?: WorkflowPhase[];
  model?: string;
}

export interface WorkflowManifest {
  meta: WorkflowMeta;
  source: string;
  sourcePath?: string;
  scope?: "user" | "project" | "runtime";
}

export interface RunOptions {
  args?: unknown;
  parentTurnId?: string;
  signal?: AbortSignal;
}

export interface RunResult {
  runId: string;
  ok: boolean;
  value?: unknown;
  error?: { name: string; message: string };
  tokensSpent: number;
  agentCount: number;
  durationMs: number;
}

export interface WorkflowRegistryService {
  list(): WorkflowManifest[];
  get(name: string): WorkflowManifest | undefined;
  register(manifest: WorkflowManifest): () => void;
  runInline(script: string, opts?: RunOptions): Promise<RunResult>;
  runByName(name: string, opts?: RunOptions): Promise<RunResult>;
}

export const CONTRACT_ID = "workflow:registry" as const;
export const DESCRIPTION = "Workflow registry — runs sandboxed multi-agent orchestration scripts (inline or named-on-disk).";
```

- [ ] **Step 2: Re-export types from public.ts**

Edit `plugins/llm-contracts/public.ts`. Add after the existing `agents-registry` re-export block:

```typescript
export type {
  WorkflowPhase,
  WorkflowMeta,
  WorkflowManifest,
  RunOptions,
  RunResult,
  WorkflowRegistryService,
} from "./contracts/workflow-registry";
```

- [ ] **Step 3: Register the contract in index.ts**

Edit `plugins/llm-contracts/index.ts`. Add import at the top (alphabetic next to siblings):

```typescript
import * as workflowRegistryContract from "./contracts/workflow-registry";
```

Then add inside `setup()` (after the last `defineService` call):

```typescript
    ctx.defineService(workflowRegistryContract.CONTRACT_ID, { description: workflowRegistryContract.DESCRIPTION });
```

- [ ] **Step 4: Write the test for defineService**

Edit `plugins/llm-contracts/index.test.ts`. Find the test that asserts the existing `defineService` calls and add an assertion for `"workflow:registry"`. Locate the existing pattern (e.g. an array of expected contract IDs or individual `expect` calls) and extend it:

```typescript
// Add to the expected-defined-services set / list:
"workflow:registry",
```

(If the test uses `toHaveBeenCalledWith(...)` per contract, add a matching call:
`expect(defineService).toHaveBeenCalledWith("workflow:registry", { description: expect.stringContaining("Workflow") });`)

- [ ] **Step 5: Run the test, expect FAIL until step 6**

Run: `cd plugins/llm-contracts && bun test`
Expected: Tests fail with "expected `workflow:registry` to have been defined" or similar.

(Test will pass after step 3's code change is in place; if step 3 was committed first the test passes immediately.)

- [ ] **Step 6: Verify all tests pass**

Run: `cd plugins/llm-contracts && bun test`
Expected: PASS.

- [ ] **Step 7: Bump version**

Edit `plugins/llm-contracts/package.json`: change `"version": "0.5.0"` to `"version": "0.6.0"`.

- [ ] **Step 8: Commit**

```bash
git add plugins/llm-contracts/
git commit -m "llm-contracts: add workflow:registry contract"
```

---

## Task 2: Add `workflow:*` events to llm-events VOCAB

**Files:**
- Modify: `plugins/llm-contracts/contracts/events.ts` (extend Vocab interface)
- Modify: `plugins/llm-events/index.ts` (add VOCAB literals)
- Modify: `plugins/llm-events/index.test.ts` (extend expected set + spot checks)
- Modify: `plugins/llm-events/package.json` (version bump)

- [ ] **Step 1: Extend the Vocab interface**

Edit `plugins/llm-contracts/contracts/events.ts`. Add the six new readonly keys after the existing `AGENT_DISPATCH_END` entry (preserve the `readonly KEY: "literal"` shape):

```typescript
  readonly WORKFLOW_START: "workflow:start";
  readonly WORKFLOW_PHASE: "workflow:phase";
  readonly WORKFLOW_AGENT_START: "workflow:agent-start";
  readonly WORKFLOW_AGENT_END: "workflow:agent-end";
  readonly WORKFLOW_LOG: "workflow:log";
  readonly WORKFLOW_END: "workflow:end";
```

- [ ] **Step 2: Add VOCAB literals**

Edit `plugins/llm-events/index.ts`. Append to the `VOCAB` object literal (inside `Object.freeze({...})`) before the closing `} as const`:

```typescript
  WORKFLOW_START: "workflow:start",
  WORKFLOW_PHASE: "workflow:phase",
  WORKFLOW_AGENT_START: "workflow:agent-start",
  WORKFLOW_AGENT_END: "workflow:agent-end",
  WORKFLOW_LOG: "workflow:log",
  WORKFLOW_END: "workflow:end",
```

- [ ] **Step 3: Write the failing test for VOCAB membership**

Edit `plugins/llm-events/index.test.ts`. Find the existing test "VOCAB contains every Spec 0 event name" (the one with a large `expected` Set) and add the six new literals:

```typescript
    "workflow:start",
    "workflow:phase",
    "workflow:agent-start",
    "workflow:agent-end",
    "workflow:log",
    "workflow:end",
```

Also add a spot-check (mirroring the existing `LLM_DONE` / `TOOLS_REGISTERED` style):

```typescript
  it("VOCAB includes workflow:* lifecycle events", () => {
    expect(VOCAB.WORKFLOW_START).toBe("workflow:start");
    expect(VOCAB.WORKFLOW_PHASE).toBe("workflow:phase");
    expect(VOCAB.WORKFLOW_AGENT_START).toBe("workflow:agent-start");
    expect(VOCAB.WORKFLOW_AGENT_END).toBe("workflow:agent-end");
    expect(VOCAB.WORKFLOW_LOG).toBe("workflow:log");
    expect(VOCAB.WORKFLOW_END).toBe("workflow:end");
  });
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `cd plugins/llm-events && bun test`
Expected: PASS (the VOCAB literals from step 2 satisfy the assertions from step 3).

- [ ] **Step 5: Bump version**

Edit `plugins/llm-events/package.json`: `"version": "0.7.0"` → `"version": "0.8.0"`.

- [ ] **Step 6: Commit**

```bash
git add plugins/llm-contracts/contracts/events.ts plugins/llm-events/
git commit -m "llm-events: add workflow:* lifecycle events"
```

---

## Task 3: Scaffold the llm-workflow plugin

**Files:**
- Create: `plugins/llm-workflow/package.json`
- Create: `plugins/llm-workflow/tsconfig.json`
- Create: `plugins/llm-workflow/README.md`
- Create: `plugins/llm-workflow/CLAUDE.md`
- Create: `plugins/llm-workflow/public.d.ts` (skeleton)
- Create: `plugins/llm-workflow/ambient.d.ts`
- Create: `plugins/llm-workflow/test/` (dir)
- Create: `plugins/llm-workflow/test/integration/` (dir)
- Create: `plugins/llm-workflow/primitives/` (dir)
- Create: `plugins/llm-workflow/index.ts` (skeleton — exports default `KaizenPlugin` so `bun test` resolves)

- [ ] **Step 1: Create the directory tree**

```bash
mkdir -p plugins/llm-workflow/test/integration plugins/llm-workflow/primitives
```

- [ ] **Step 2: Write package.json**

`plugins/llm-workflow/package.json`:

```json
{
  "name": "llm-workflow",
  "version": "0.1.0",
  "description": "Sandboxed multi-agent workflow orchestration for the local harness.",
  "type": "module",
  "exports": {
    ".": "./index.ts",
    "./public": "./public.d.ts",
    "./ambient": "./ambient.d.ts"
  },
  "keywords": ["kaizen-plugin"],
  "dependencies": {
    "kaizen-config": "workspace:*",
    "llm-contracts": "workspace:*",
    "llm-events": "workspace:*",
    "llm-tools-registry": "workspace:*",
    "llm-driver": "workspace:*",
    "llm-session-manager": "workspace:*",
    "llm-system-prompt": "workspace:*"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "@types/json-schema": "^7.0.15",
    "typescript": "^5.4.0"
  }
}
```

- [ ] **Step 3: Write tsconfig.json**

`plugins/llm-workflow/tsconfig.json` — copy verbatim from llm-agents:

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
    "resolveJsonModule": true,
    "types": ["bun"]
  },
  "include": ["**/*.ts"]
}
```

- [ ] **Step 4: Write README.md skeleton**

`plugins/llm-workflow/README.md`:

```markdown
# llm-workflow

Sandboxed multi-agent workflow orchestration. Provides `workflow:registry`. Registers the `Workflow` tool with `tools:registry` and `/workflows:run`, `/workflows:list`, `/workflows:get` slash commands.

See `docs/superpowers/specs/2026-05-28-llm-workflow-design.md` for the full design. This README will be expanded as the plugin lands; it is intentionally minimal during the implementation plan.
```

- [ ] **Step 5: Write CLAUDE.md skeleton**

`plugins/llm-workflow/CLAUDE.md`:

```markdown
# Working in `llm-workflow`

Notes for agents editing this plugin. See `README.md` for the user-facing contract and `docs/superpowers/specs/2026-05-28-llm-workflow-design.md` for the design.

## Module map

(Populated as the plugin lands. See plan tasks for current module responsibilities.)

## Invariants

- **Sandboxed scripts.** Worker source is evaluated via `AsyncFunction`; primitives are non-configurable, non-writable globals.
- **Determinism guards.** `Date.now()`, `Math.random()`, argless `new Date()` throw inside the worker (preserve resume-readiness).
- **Static meta extraction.** `meta` is parsed via AST before sandbox spawn; `meta` must be a pure literal.
- **One semaphore per RunContext.** Nested `workflow()` shares it. Lifetime cap (1000) is hard.
- **Names from disk match filename basename.** Frontmatter convention `name === path.basename(file, ".ts")`.
- **Programmatic registrations require `runtime:` prefix.** Same convention as llm-agents.

## Local deploy

```bash
PLUGIN=llm-workflow
VERSION=$(jq -r .version plugins/$PLUGIN/package.json)
INSTALL_DIR=~/.kaizen/marketplaces/official/plugins/${PLUGIN}@${VERSION}
(cd plugins/$PLUGIN && bun build --target=bun --outfile=dist/index.js index.ts)
mkdir -p "$INSTALL_DIR/dist"
cp plugins/$PLUGIN/dist/index.js "$INSTALL_DIR/dist/index.js"
rsync -a --exclude='node_modules' --exclude='dist' plugins/$PLUGIN/ "$INSTALL_DIR/"
```

`sandbox-entry.ts` is loaded by URL at runtime — keep it alongside the bundle, do not bundle it into `dist/index.js`.
```

- [ ] **Step 6: Write public.d.ts skeleton**

`plugins/llm-workflow/public.d.ts`:

```typescript
// Implementation-internal public surface for llm-workflow.
// Cross-plugin contract types live in llm-contracts/public.

export interface WorkflowConfigFile {
  userDir: string;
  projectDir: string;
  maxConcurrency: number | null;
  maxLifetimeAgents: number;
  timeoutMs: number;
  workerGracefulShutdownMs: number;
  metaParse: {
    maxFileBytes: number;
  };
}

export {
  MetaParseError,
  WorkerSpawnError,
  ScriptError,
  WorkflowTimeoutError,
  WorkflowAbortedError,
  WorkflowNestingError,
  AgentLifetimeCapError,
  BudgetExceededError,
  WorkflowRegistryLoadingError,
  WorkflowNotFoundError,
} from "./errors.ts";
```

- [ ] **Step 7: Write ambient.d.ts (for workflow authors)**

`plugins/llm-workflow/ambient.d.ts`:

```typescript
// Ambient globals injected into a workflow script by the llm-workflow sandbox.
// Workflow authors can reference this file via:
//   /// <reference path="../../node_modules/llm-workflow/ambient.d.ts" />
// or import as a type-only module.

import type { WorkflowPhase } from "llm-contracts/public";

declare global {
  /** Run a subagent. Returns the final assistant text. */
  function agent(prompt: string, opts?: {
    label?: string;
    phase?: string;
    schema?: object;          // reserved (v1.1)
    model?: string;
    isolation?: "worktree";   // reserved (v1.1)
    agentType?: string;
  }): Promise<string | null>;

  /** Run thunks concurrently — barrier. Failures resolve to `null` in the result array. */
  function parallel<T = unknown>(thunks: Array<() => Promise<T>>): Promise<Array<T | null>>;

  /** Pipeline items across stages with no barrier between stages. */
  function pipeline<T = unknown>(items: T[], ...stages: Array<(prev: unknown, item: T, index: number) => Promise<unknown>>): Promise<unknown[]>;

  /** Emit a phase boundary in the progress stream. */
  function phase(title: string): void;

  /** Emit a free-form narrator line. */
  function log(message: string): void;

  /** Run a child workflow. Shares this run's semaphore, budget, abort signal, and lifetime counter. */
  function workflow(nameOrRef: string | { scriptPath: string }, args?: unknown): Promise<unknown>;

  /** Args passed via RunOptions.args at invocation time. */
  const args: any;

  /** Budget accounting. */
  const budget: {
    total: number | null;
    spent(): Promise<number>;
    remaining(): Promise<number>;
  };
}

export {};
```

- [ ] **Step 8: Write minimal index.ts skeleton**

`plugins/llm-workflow/index.ts`:

```typescript
import type { KaizenPlugin } from "kaizen/types";

const plugin: KaizenPlugin = {
  name: "llm-workflow",
  apiVersion: "3.0.0",
  permissions: { tier: "unscoped" },
  services: {
    provides: ["workflow:registry"],
    consumes: [
      "events:vocabulary",
      "driver:run-conversation",
      "tools:registry",
      "slash:registry",
      "agents:registry",
      "prompt:registry",
      "config:store",
    ],
  },

  async setup(_ctx) {
    // Wiring lands in Task 21.
  },

  async stop() {
    // Cleanup lands in Task 21.
  },
};

export default plugin;
```

- [ ] **Step 9: Run install + smoke test**

```bash
bun install
cd plugins/llm-workflow && bun test
```

Expected: `bun install` succeeds (workspace deps resolve). `bun test` reports 0 tests, no failures.

- [ ] **Step 10: Commit**

```bash
git add plugins/llm-workflow/
git commit -m "llm-workflow: scaffold plugin (package, tsconfig, skeleton)"
```

---

## Task 4: Errors module

**Files:**
- Create: `plugins/llm-workflow/errors.ts`
- Create: `plugins/llm-workflow/test/errors.test.ts`

- [ ] **Step 1: Write the failing test**

`plugins/llm-workflow/test/errors.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import {
  MetaParseError,
  WorkerSpawnError,
  ScriptError,
  WorkflowTimeoutError,
  WorkflowAbortedError,
  WorkflowNestingError,
  AgentLifetimeCapError,
  BudgetExceededError,
  WorkflowRegistryLoadingError,
  WorkflowNotFoundError,
} from "../errors.ts";

describe("workflow errors", () => {
  const cases: Array<{ Ctor: new (msg: string) => Error; name: string }> = [
    { Ctor: MetaParseError, name: "MetaParseError" },
    { Ctor: WorkerSpawnError, name: "WorkerSpawnError" },
    { Ctor: ScriptError, name: "ScriptError" },
    { Ctor: WorkflowTimeoutError, name: "WorkflowTimeoutError" },
    { Ctor: WorkflowAbortedError, name: "WorkflowAbortedError" },
    { Ctor: WorkflowNestingError, name: "WorkflowNestingError" },
    { Ctor: AgentLifetimeCapError, name: "AgentLifetimeCapError" },
    { Ctor: BudgetExceededError, name: "BudgetExceededError" },
    { Ctor: WorkflowRegistryLoadingError, name: "WorkflowRegistryLoadingError" },
    { Ctor: WorkflowNotFoundError, name: "WorkflowNotFoundError" },
  ];
  for (const { Ctor, name } of cases) {
    it(`${name} is an Error with name="${name}"`, () => {
      const e = new Ctor("boom");
      expect(e).toBeInstanceOf(Error);
      expect(e.name).toBe(name);
      expect(e.message).toBe("boom");
    });
  }
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd plugins/llm-workflow && bun test test/errors.test.ts`
Expected: FAIL — module resolution error for `../errors.ts`.

- [ ] **Step 3: Implement errors.ts**

`plugins/llm-workflow/errors.ts`:

```typescript
function makeError(name: string) {
  return class extends Error {
    constructor(message: string) { super(message); this.name = name; }
  };
}

export const MetaParseError = makeError("MetaParseError");
export const WorkerSpawnError = makeError("WorkerSpawnError");
export const ScriptError = makeError("ScriptError");
export const WorkflowTimeoutError = makeError("WorkflowTimeoutError");
export const WorkflowAbortedError = makeError("WorkflowAbortedError");
export const WorkflowNestingError = makeError("WorkflowNestingError");
export const AgentLifetimeCapError = makeError("AgentLifetimeCapError");
export const BudgetExceededError = makeError("BudgetExceededError");
export const WorkflowRegistryLoadingError = makeError("WorkflowRegistryLoadingError");
export const WorkflowNotFoundError = makeError("WorkflowNotFoundError");
```

- [ ] **Step 4: Run, expect PASS**

Run: `cd plugins/llm-workflow && bun test test/errors.test.ts`
Expected: PASS (10 cases).

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-workflow/errors.ts plugins/llm-workflow/test/errors.test.ts
git commit -m "llm-workflow: add error classes"
```

---

## Task 5: Config module

**Files:**
- Create: `plugins/llm-workflow/config.ts`
- Create: `plugins/llm-workflow/test/config.test.ts`

- [ ] **Step 1: Write the failing test**

`plugins/llm-workflow/test/config.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import { DEFAULT_CONFIG, CONFIG_SCHEMA } from "../config.ts";

describe("config", () => {
  it("DEFAULT_CONFIG is frozen and matches spec defaults", () => {
    expect(Object.isFrozen(DEFAULT_CONFIG)).toBe(true);
    expect(DEFAULT_CONFIG.userDir).toBe("~/.kaizen/workflows");
    expect(DEFAULT_CONFIG.projectDir).toBe(".kaizen/workflows");
    expect(DEFAULT_CONFIG.maxConcurrency).toBeNull();
    expect(DEFAULT_CONFIG.maxLifetimeAgents).toBe(1000);
    expect(DEFAULT_CONFIG.timeoutMs).toBe(600000);
    expect(DEFAULT_CONFIG.workerGracefulShutdownMs).toBe(1000);
    expect(DEFAULT_CONFIG.metaParse.maxFileBytes).toBe(65536);
  });

  it("CONFIG_SCHEMA is a JSON Schema with the expected property names", () => {
    expect(CONFIG_SCHEMA.type).toBe("object");
    const props = (CONFIG_SCHEMA as any).properties;
    for (const k of ["userDir","projectDir","maxConcurrency","maxLifetimeAgents","timeoutMs","workerGracefulShutdownMs","metaParse"]) {
      expect(props[k]).toBeDefined();
    }
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd plugins/llm-workflow && bun test test/config.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement config.ts**

`plugins/llm-workflow/config.ts`:

```typescript
import type { JSONSchema7 } from "json-schema";
import type { WorkflowConfigFile } from "./public.d.ts";

export const DEFAULT_CONFIG: Readonly<WorkflowConfigFile> = Object.freeze({
  userDir: "~/.kaizen/workflows",
  projectDir: ".kaizen/workflows",
  maxConcurrency: null,
  maxLifetimeAgents: 1000,
  timeoutMs: 600000,
  workerGracefulShutdownMs: 1000,
  metaParse: Object.freeze({ maxFileBytes: 65536 }),
}) as Readonly<WorkflowConfigFile>;

export const CONFIG_SCHEMA: JSONSchema7 = {
  type: "object",
  additionalProperties: false,
  properties: {
    userDir: { type: "string" },
    projectDir: { type: "string" },
    maxConcurrency: { type: ["integer", "null"], minimum: 1 },
    maxLifetimeAgents: { type: "integer", minimum: 1 },
    timeoutMs: { type: "integer", minimum: 1000 },
    workerGracefulShutdownMs: { type: "integer", minimum: 0 },
    metaParse: {
      type: "object",
      additionalProperties: false,
      properties: {
        maxFileBytes: { type: "integer", minimum: 1024 },
      },
    },
  },
};
```

- [ ] **Step 4: Run, expect PASS**

Run: `cd plugins/llm-workflow && bun test test/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-workflow/config.ts plugins/llm-workflow/test/config.test.ts
git commit -m "llm-workflow: add config schema and defaults"
```

---

## Task 6: meta-parse — static AST extraction

**Files:**
- Create: `plugins/llm-workflow/meta-parse.ts`
- Create: `plugins/llm-workflow/test/meta-parse.test.ts`

**Rationale:** Bun ships a `Transpiler` API that can return a parsed AST/JSON via `scan()` and `scanImports()`, but for extracting a single `export const meta = {...}` pure-literal object we use a controlled `AsyncFunction` evaluation of *only* the meta sub-expression (NOT the whole script). This is safe because the literal must be free of identifiers and function calls — any non-literal expression throws `MetaParseError`. The implementation uses Bun's transpiler to lex, then walks tokens to find `export const meta = ` followed by the object literal expression; only that substring is passed to `JSON.parse` after a strict literal-only sanity pass via regex/structural check.

For simplicity and robustness, we use a regex-based extractor: locate `export const meta = ` then balance braces. Once extracted, we validate the literal by running `JSON.parse` on a normalized form (single quotes → double, trailing comma stripped, identifier keys quoted). If JSON.parse fails OR if any disallowed token (backticks, `${`, identifiers other than the meta keys, function calls, spreads) is present in the slice, we throw `MetaParseError`.

- [ ] **Step 1: Write the failing test**

`plugins/llm-workflow/test/meta-parse.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import { extractMeta } from "../meta-parse.ts";
import { MetaParseError } from "../errors.ts";

describe("extractMeta", () => {
  it("extracts a minimal meta literal", () => {
    const src = `
      export const meta = {
        name: "demo",
        description: "demo workflow"
      };
      phase("X");
      log("hi");
    `;
    const meta = extractMeta(src);
    expect(meta.name).toBe("demo");
    expect(meta.description).toBe("demo workflow");
  });

  it("extracts phases array with nested objects", () => {
    const src = `export const meta = {
      name: "review-changes",
      description: "Review",
      phases: [
        { title: "Scan", detail: "grep test logs" },
        { title: "Fix" }
      ]
    };`;
    const meta = extractMeta(src);
    expect(meta.phases).toEqual([
      { title: "Scan", detail: "grep test logs" },
      { title: "Fix" },
    ]);
  });

  it("rejects spread", () => {
    const src = `export const meta = { ...other, name: "x", description: "y" };`;
    expect(() => extractMeta(src)).toThrow(MetaParseError);
  });

  it("rejects template-string interpolation", () => {
    const src = "export const meta = { name: `dyn-${1}`, description: \"d\" };";
    expect(() => extractMeta(src)).toThrow(MetaParseError);
  });

  it("rejects identifier reference for value", () => {
    const src = `const N = "x"; export const meta = { name: N, description: "d" };`;
    expect(() => extractMeta(src)).toThrow(MetaParseError);
  });

  it("rejects missing required keys", () => {
    const src = `export const meta = { name: "x" };`;
    expect(() => extractMeta(src)).toThrow(MetaParseError);
  });

  it("rejects function call inside meta", () => {
    const src = `export const meta = { name: fn(), description: "d" };`;
    expect(() => extractMeta(src)).toThrow(MetaParseError);
  });

  it("rejects when no export const meta present", () => {
    const src = `phase("x"); log("y");`;
    expect(() => extractMeta(src)).toThrow(MetaParseError);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd plugins/llm-workflow && bun test test/meta-parse.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement meta-parse.ts**

`plugins/llm-workflow/meta-parse.ts`:

```typescript
import type { WorkflowMeta } from "llm-contracts/public";
import { MetaParseError } from "./errors.ts";

const META_RE = /export\s+const\s+meta\s*=\s*\{/;

/**
 * Extract `export const meta = {...}` from a workflow script source.
 * `meta` MUST be a pure object literal — strings/numbers/booleans/null/arrays/objects only.
 * Any identifier reference, template interpolation, spread, or function call rejects.
 */
export function extractMeta(source: string): WorkflowMeta {
  const m = META_RE.exec(source);
  if (!m) throw new MetaParseError("no `export const meta = {...}` found");
  const openIdx = m.index + m[0].length - 1; // position of '{'
  const slice = extractBalanced(source, openIdx);
  if (slice == null) throw new MetaParseError("meta literal not balanced (missing closing brace)");

  // Disallow forbidden constructs anywhere in the slice.
  rejectDisallowed(slice);

  // Normalize JS-object literal to JSON: quote unquoted identifier keys, strip trailing commas.
  const normalized = normalizeToJson(slice);

  let parsed: unknown;
  try { parsed = JSON.parse(normalized); }
  catch (e) { throw new MetaParseError(`meta literal is not valid JSON-like: ${(e as Error).message}`); }

  if (!isPlainObject(parsed)) throw new MetaParseError("meta is not an object");

  const meta = parsed as Record<string, unknown>;
  if (typeof meta.name !== "string" || meta.name.length === 0) {
    throw new MetaParseError("meta.name must be a non-empty string");
  }
  if (typeof meta.description !== "string" || meta.description.length === 0) {
    throw new MetaParseError("meta.description must be a non-empty string");
  }
  return meta as unknown as WorkflowMeta;
}

function extractBalanced(src: string, openIdx: number): string | null {
  let depth = 0;
  let inStr: string | null = null;
  let escape = false;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i]!;
    if (escape) { escape = false; continue; }
    if (inStr) {
      if (c === "\\") { escape = true; continue; }
      if (c === inStr) { inStr = null; continue; }
      continue;
    }
    if (c === '"' || c === "'") { inStr = c; continue; }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(openIdx, i + 1);
    }
  }
  return null;
}

function rejectDisallowed(slice: string): void {
  // Backtick template literals — interpolation lives there.
  if (slice.includes("`")) throw new MetaParseError("template literals are not allowed in meta");
  // Spread.
  if (/\.\.\./.test(slice)) throw new MetaParseError("spread is not allowed in meta");
  // Function-call parens after an identifier (very conservative — disallow any `(` outside strings).
  const stripped = stripStrings(slice);
  if (/\(/.test(stripped)) throw new MetaParseError("function calls are not allowed in meta");
  // Identifier references as values: any identifier that isn't `true|false|null` and appears as a value.
  // Simplest check: after a colon, the next non-whitespace, non-bracket, non-quote char must be a digit, '-',
  // 't' (true), 'f' (false), 'n' (null), '{', '[', or a string quote.
  const valuePos = /:\s*([A-Za-z_$])/g;
  let match: RegExpExecArray | null;
  while ((match = valuePos.exec(stripped))) {
    const startAt = match.index + match[0].length - 1;
    const ident = stripped.slice(startAt).match(/^[A-Za-z_$][A-Za-z_$0-9]*/)?.[0] ?? "";
    if (ident !== "true" && ident !== "false" && ident !== "null") {
      throw new MetaParseError(`identifier reference '${ident}' is not allowed as a meta value`);
    }
  }
}

function stripStrings(s: string): string {
  let out = "";
  let inStr: string | null = null;
  let escape = false;
  for (const c of s) {
    if (escape) { escape = false; out += " "; continue; }
    if (inStr) {
      if (c === "\\") { escape = true; out += " "; continue; }
      if (c === inStr) { inStr = null; out += " "; continue; }
      out += " ";
      continue;
    }
    if (c === '"' || c === "'") { inStr = c; out += " "; continue; }
    out += c;
  }
  return out;
}

function normalizeToJson(slice: string): string {
  // 1) Replace single-quoted strings with double-quoted (preserve escapes).
  let out = "";
  let inStr: string | null = null;
  let escape = false;
  for (const c of slice) {
    if (escape) { out += c; escape = false; continue; }
    if (inStr) {
      if (c === "\\") { out += c; escape = true; continue; }
      if (c === inStr) {
        out += inStr === "'" ? '"' : c;
        inStr = null;
        continue;
      }
      // Convert any double-quote inside a single-quoted string to escaped form.
      if (inStr === "'" && c === '"') { out += '\\"'; continue; }
      out += c;
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = c;
      out += '"';
      continue;
    }
    out += c;
  }
  // 2) Quote unquoted identifier keys: `name:` → `"name":`.
  out = out.replace(/([\{,\s])([A-Za-z_$][A-Za-z_$0-9]*)\s*:/g, '$1"$2":');
  // 3) Strip trailing commas inside objects/arrays.
  out = out.replace(/,(\s*[\}\]])/g, "$1");
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `cd plugins/llm-workflow && bun test test/meta-parse.test.ts`
Expected: PASS (8 cases).

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-workflow/meta-parse.ts plugins/llm-workflow/test/meta-parse.test.ts
git commit -m "llm-workflow: add meta-parse (pure-literal AST extraction)"
```

---

## Task 7: Semaphore module

**Files:**
- Create: `plugins/llm-workflow/semaphore.ts`
- Create: `plugins/llm-workflow/test/semaphore.test.ts`

- [ ] **Step 1: Write the failing test**

`plugins/llm-workflow/test/semaphore.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import { makeSemaphore } from "../semaphore.ts";
import { AgentLifetimeCapError } from "../errors.ts";

describe("semaphore", () => {
  it("enforces concurrent cap", async () => {
    const sem = makeSemaphore({ maxConcurrency: 2, maxLifetimeAgents: 100 });
    let inflight = 0; let peak = 0;
    const run = async () => {
      await sem.acquire();
      inflight++; peak = Math.max(peak, inflight);
      await new Promise((r) => setTimeout(r, 5));
      inflight--;
      sem.release();
    };
    await Promise.all([run(), run(), run(), run()]);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("counts lifetime acquires across releases", async () => {
    const sem = makeSemaphore({ maxConcurrency: 4, maxLifetimeAgents: 3 });
    await sem.acquire(); sem.release();
    await sem.acquire(); sem.release();
    await sem.acquire(); sem.release();
    await expect(sem.acquire()).rejects.toBeInstanceOf(AgentLifetimeCapError);
  });

  it("release is safe to over-call (drops to zero, never negative)", () => {
    const sem = makeSemaphore({ maxConcurrency: 1, maxLifetimeAgents: 100 });
    sem.release(); // no-op (count already 0)
    expect(sem.inflight()).toBe(0);
  });

  it("reports counters", async () => {
    const sem = makeSemaphore({ maxConcurrency: 4, maxLifetimeAgents: 100 });
    await sem.acquire();
    expect(sem.lifetime()).toBe(1);
    expect(sem.inflight()).toBe(1);
    sem.release();
    expect(sem.inflight()).toBe(0);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd plugins/llm-workflow && bun test test/semaphore.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement semaphore.ts**

`plugins/llm-workflow/semaphore.ts`:

```typescript
import { AgentLifetimeCapError } from "./errors.ts";

export interface SemaphoreOptions {
  maxConcurrency: number;
  maxLifetimeAgents: number;
}

export interface Semaphore {
  acquire(): Promise<void>;
  release(): void;
  inflight(): number;
  lifetime(): number;
}

export function makeSemaphore(opts: SemaphoreOptions): Semaphore {
  let inflight = 0;
  let lifetime = 0;
  const waiters: Array<() => void> = [];

  function acquire(): Promise<void> {
    if (lifetime >= opts.maxLifetimeAgents) {
      return Promise.reject(new AgentLifetimeCapError(
        `workflow exceeded lifetime agent cap of ${opts.maxLifetimeAgents}`,
      ));
    }
    lifetime++;
    if (inflight < opts.maxConcurrency) {
      inflight++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      waiters.push(() => { inflight++; resolve(); });
    });
  }

  function release(): void {
    if (inflight === 0 && waiters.length === 0) return;
    if (inflight > 0) inflight--;
    const next = waiters.shift();
    if (next) next();
  }

  return {
    acquire,
    release,
    inflight: () => inflight,
    lifetime: () => lifetime,
  };
}

/** Resolve max-concurrency cap from config: explicit value, or auto = min(16, max(1, cpus - 2)). */
export function resolveMaxConcurrency(cfg: number | null, cpuCount: number): number {
  if (cfg !== null && cfg > 0) return cfg;
  return Math.min(16, Math.max(1, cpuCount - 2));
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `cd plugins/llm-workflow && bun test test/semaphore.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-workflow/semaphore.ts plugins/llm-workflow/test/semaphore.test.ts
git commit -m "llm-workflow: add semaphore (concurrency + lifetime cap)"
```

---

## Task 8: Budget module

**Files:**
- Create: `plugins/llm-workflow/budget.ts`
- Create: `plugins/llm-workflow/test/budget.test.ts`

- [ ] **Step 1: Write the failing test**

`plugins/llm-workflow/test/budget.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import { makeBudget } from "../budget.ts";
import { BudgetExceededError } from "../errors.ts";

describe("budget", () => {
  it("starts at 0, accumulates from add()", () => {
    const b = makeBudget({ total: null });
    expect(b.spent()).toBe(0);
    b.add(10);
    b.add(15);
    expect(b.spent()).toBe(25);
  });

  it("remaining returns Infinity when total is null", () => {
    const b = makeBudget({ total: null });
    expect(b.remaining()).toBe(Infinity);
    b.add(50);
    expect(b.remaining()).toBe(Infinity);
  });

  it("remaining returns max(0, total - spent)", () => {
    const b = makeBudget({ total: 100 });
    expect(b.remaining()).toBe(100);
    b.add(30);
    expect(b.remaining()).toBe(70);
    b.add(80);
    expect(b.remaining()).toBe(0);
  });

  it("assertNotExceeded throws BudgetExceededError once at the cap", () => {
    const b = makeBudget({ total: 100 });
    b.add(100);
    expect(() => b.assertNotExceeded()).toThrow(BudgetExceededError);
  });

  it("assertNotExceeded is a no-op when total is null", () => {
    const b = makeBudget({ total: null });
    b.add(999999);
    expect(() => b.assertNotExceeded()).not.toThrow();
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd plugins/llm-workflow && bun test test/budget.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement budget.ts**

`plugins/llm-workflow/budget.ts`:

```typescript
import { BudgetExceededError } from "./errors.ts";

export interface BudgetOptions {
  total: number | null;
}

export interface Budget {
  total: number | null;
  spent(): number;
  remaining(): number;
  add(n: number): void;
  assertNotExceeded(): void;
}

export function makeBudget(opts: BudgetOptions): Budget {
  let used = 0;
  return {
    get total() { return opts.total; },
    spent() { return used; },
    remaining() {
      if (opts.total == null) return Infinity;
      return Math.max(0, opts.total - used);
    },
    add(n: number) {
      if (typeof n === "number" && Number.isFinite(n) && n > 0) used += n;
    },
    assertNotExceeded() {
      if (opts.total != null && used >= opts.total) {
        throw new BudgetExceededError(
          `workflow exceeded token budget of ${opts.total} (spent ${used})`,
        );
      }
    },
  };
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `cd plugins/llm-workflow && bun test test/budget.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-workflow/budget.ts plugins/llm-workflow/test/budget.test.ts
git commit -m "llm-workflow: add budget (token accounting)"
```

---

## Task 9: Registry module

**Files:**
- Create: `plugins/llm-workflow/registry.ts`
- Create: `plugins/llm-workflow/test/registry.test.ts`

- [ ] **Step 1: Write the failing test**

`plugins/llm-workflow/test/registry.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import { makeRegistry, makeRegistryHandle } from "../registry.ts";
import type { WorkflowManifest } from "llm-contracts/public";

function mf(name: string, source = "// noop"): WorkflowManifest {
  return {
    meta: { name, description: `Desc of ${name}` },
    source,
    scope: "user",
    sourcePath: `<runtime>`,
  };
}

describe("registry", () => {
  it("list() returns public manifests", () => {
    const r = makeRegistry([mf("foo"), mf("bar")]);
    const names = r.service.list().map((m) => m.meta.name).sort();
    expect(names).toEqual(["bar", "foo"]);
  });

  it("get() returns the matching manifest, or undefined", () => {
    const r = makeRegistry([mf("foo")]);
    expect(r.service.get("foo")?.meta.name).toBe("foo");
    expect(r.service.get("missing")).toBeUndefined();
  });

  it("register() requires runtime: prefix", () => {
    const r = makeRegistry([]);
    expect(() => r.service.register(mf("plain"))).toThrow(/runtime:/);
    const unregister = r.service.register(mf("runtime:dynamic"));
    expect(r.service.get("runtime:dynamic")?.meta.name).toBe("runtime:dynamic");
    unregister();
    expect(r.service.get("runtime:dynamic")).toBeUndefined();
  });

  it("register() rejects collision", () => {
    const r = makeRegistry([mf("runtime:x")]);
    expect(() => r.service.register(mf("runtime:x"))).toThrow(/already registered/);
  });

  it("handle.setInner swaps the inner registry while preserving the service reference", () => {
    const h = makeRegistryHandle(makeRegistry([mf("foo")]));
    const svc = h.service;
    expect(svc.list().length).toBe(1);
    h.setInner(makeRegistry([mf("bar"), mf("baz")]));
    expect(svc.list().length).toBe(2);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd plugins/llm-workflow && bun test test/registry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement registry.ts**

`plugins/llm-workflow/registry.ts`:

```typescript
import type { WorkflowManifest, WorkflowRegistryService, RunOptions, RunResult } from "llm-contracts/public";

export interface Registry {
  service: Pick<WorkflowRegistryService, "list" | "get" | "register">;
}

/**
 * Build an in-memory registry around a fixed initial manifest set.
 * `runInline` / `runByName` live in `engine.ts` — this module owns naming + list/get/register only.
 */
export function makeRegistry(initial: WorkflowManifest[], onChange?: () => void): Registry {
  const map = new Map<string, WorkflowManifest>();
  for (const m of initial) map.set(m.meta.name, m);

  const service: Pick<WorkflowRegistryService, "list" | "get" | "register"> = {
    list() { return [...map.values()]; },
    get(name) { return map.get(name); },
    register(manifest: WorkflowManifest) {
      const name = manifest.meta.name;
      if (!name.startsWith("runtime:")) {
        throw new Error(`workflow:registry.register requires names with 'runtime:' prefix; got '${name}'`);
      }
      if (map.has(name)) {
        throw new Error(`workflow:registry: name '${name}' already registered`);
      }
      map.set(name, { ...manifest, scope: manifest.scope ?? "runtime", sourcePath: manifest.sourcePath ?? "<runtime>" });
      onChange?.();
      return () => { map.delete(name); onChange?.(); };
    },
  };

  return { service };
}

export interface RegistryHandle {
  service: Pick<WorkflowRegistryService, "list" | "get" | "register">;
  setInner(next: Registry, onChange?: () => void): void;
}

export function makeRegistryHandle(initial: Registry): RegistryHandle {
  let inner = initial;
  return {
    get service() {
      return {
        list: () => inner.service.list(),
        get: (n: string) => inner.service.get(n),
        register: (m: WorkflowManifest) => inner.service.register(m),
      };
    },
    setInner(next, onChange) { inner = next; onChange?.(); },
  };
}

// Re-export for runner.ts / engine.ts convenience.
export type { WorkflowManifest, WorkflowRegistryService, RunOptions, RunResult };
```

- [ ] **Step 4: Run, expect PASS**

Run: `cd plugins/llm-workflow && bun test test/registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-workflow/registry.ts plugins/llm-workflow/test/registry.test.ts
git commit -m "llm-workflow: add in-memory registry"
```

---

## Task 10: Loader — file discovery

**Files:**
- Create: `plugins/llm-workflow/loader.ts`
- Create: `plugins/llm-workflow/test/loader.test.ts`

- [ ] **Step 1: Write the failing test**

`plugins/llm-workflow/test/loader.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import { loadFromDirs } from "../loader.ts";

function makeFs(files: Record<string, string>) {
  const entries: Record<string, string[]> = {};
  for (const path of Object.keys(files)) {
    let dir = path.substring(0, path.lastIndexOf("/"));
    while (dir.length > 0) {
      const parent = dir.substring(0, dir.lastIndexOf("/"));
      entries[dir] ??= [];
      const child = dir.substring(parent.length + 1);
      if (parent !== "" && !(entries[parent] ?? []).includes(child)) {
        entries[parent] ??= [];
        entries[parent]!.push(child);
      }
      const name = path.substring(dir.length + 1);
      if (!entries[dir]!.includes(name)) entries[dir]!.push(name);
      if (parent === "") break;
      dir = parent;
    }
  }
  return {
    readDir: async (p: string) => entries[p] ? [...entries[p]] : (() => { const e: any = new Error("ENOENT"); e.code = "ENOENT"; throw e; })(),
    stat: async (p: string) => ({
      isFile: () => files[p] !== undefined,
      isDirectory: () => entries[p] !== undefined,
      isSymbolicLink: () => false,
      size: files[p] ? Buffer.byteLength(files[p]!, "utf8") : 0,
    }),
    realpath: async (p: string) => p,
    readFile: async (p: string) => { const v = files[p]; if (v === undefined) throw new Error("ENOENT"); return v; },
  };
}

const validSrc = (name: string) => `export const meta = { name: "${name}", description: "Desc ${name}" };\n`;

describe("loadFromDirs", () => {
  it("discovers .ts files from both scopes; project shadows user", async () => {
    const fs = makeFs({
      "/u/foo.ts": validSrc("foo"),
      "/u/bar.ts": validSrc("bar"),
      "/p/bar.ts": validSrc("bar"), // shadow
    });
    const res = await loadFromDirs({ userDir: "/u", projectDir: "/p", deps: fs });
    const byName = Object.fromEntries(res.manifests.map((m) => [m.meta.name, m]));
    expect(Object.keys(byName).sort()).toEqual(["bar", "foo"]);
    expect(byName.bar!.scope).toBe("project");
    expect(byName.foo!.scope).toBe("user");
  });

  it("skips non-.ts files", async () => {
    const fs = makeFs({
      "/u/foo.ts": validSrc("foo"),
      "/u/skip.md": "ignore me",
      "/u/skip.json": "{}",
    });
    const res = await loadFromDirs({ userDir: "/u", projectDir: "/p", deps: fs });
    expect(res.manifests.length).toBe(1);
    expect(res.manifests[0]!.meta.name).toBe("foo");
  });

  it("rejects files exceeding maxFileBytes", async () => {
    const big = "x".repeat(70_000);
    const fs = makeFs({ "/u/foo.ts": validSrc("foo") + big });
    const res = await loadFromDirs({ userDir: "/u", projectDir: "/p", deps: fs, maxFileBytes: 65536 });
    expect(res.manifests.length).toBe(0);
    expect(res.errors[0]!.message).toMatch(/exceeds .* cap/);
  });

  it("rejects filename-mismatch", async () => {
    const fs = makeFs({ "/u/foo.ts": validSrc("bar") });
    const res = await loadFromDirs({ userDir: "/u", projectDir: "/p", deps: fs });
    expect(res.manifests.length).toBe(0);
    expect(res.errors[0]!.message).toMatch(/filename basename/);
  });

  it("captures meta-parse errors per file without poisoning others", async () => {
    const fs = makeFs({
      "/u/ok.ts": validSrc("ok"),
      "/u/bad.ts": `export const meta = { description: "missing name" };`,
    });
    const res = await loadFromDirs({ userDir: "/u", projectDir: "/p", deps: fs });
    expect(res.manifests.length).toBe(1);
    expect(res.manifests[0]!.meta.name).toBe("ok");
    expect(res.errors.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd plugins/llm-workflow && bun test test/loader.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement loader.ts**

`plugins/llm-workflow/loader.ts`:

```typescript
import type { WorkflowManifest } from "llm-contracts/public";
import { extractMeta } from "./meta-parse.ts";
import { MetaParseError } from "./errors.ts";

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
  maxFileBytes?: number;
}

export interface LoaderError { path: string; message: string; }

export interface LoaderResult {
  manifests: WorkflowManifest[];
  errors: LoaderError[];
}

const DEFAULT_MAX_BYTES = 64 * 1024;
const MAX_DEPTH = 8;

async function loadOneScope(
  rootDir: string,
  scope: "user" | "project",
  deps: LoaderDeps,
  maxBytes: number,
  errors: LoaderError[],
): Promise<WorkflowManifest[]> {
  const collected: string[] = [];
  const seenRealPaths = new Set<string>();

  async function walk(dir: string, depth: number): Promise<void> {
    let entries: string[];
    try { entries = await deps.readDir(dir); }
    catch (err: any) {
      if (err?.code === "ENOENT") return;
      errors.push({ path: dir, message: `failed to read dir: ${err?.message ?? err}` });
      return;
    }
    entries.sort();
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const fullPath = `${dir}/${entry}`;
      let st;
      try { st = await deps.stat(fullPath); }
      catch (err: any) { errors.push({ path: fullPath, message: `stat failed: ${err?.message ?? err}` }); continue; }
      if (st.isDirectory()) {
        if (depth >= MAX_DEPTH) { errors.push({ path: fullPath, message: `directory depth exceeds ${MAX_DEPTH}; skipped` }); continue; }
        let real = fullPath;
        if (st.isSymbolicLink()) {
          try { real = await deps.realpath(fullPath); }
          catch (err: any) { errors.push({ path: fullPath, message: `realpath failed: ${err?.message ?? err}` }); continue; }
          if (seenRealPaths.has(real)) { errors.push({ path: fullPath, message: `symlink cycle detected; skipped` }); continue; }
          seenRealPaths.add(real);
        } else {
          seenRealPaths.add(real);
        }
        await walk(fullPath, depth + 1);
        continue;
      }
      if (!st.isFile()) continue;
      if (!entry.endsWith(".ts")) continue;
      collected.push(fullPath);
    }
  }

  await walk(rootDir, 1);
  collected.sort();

  const out: WorkflowManifest[] = [];
  const seenNames = new Set<string>();
  for (const fullPath of collected) {
    let st;
    try { st = await deps.stat(fullPath); }
    catch (err: any) { errors.push({ path: fullPath, message: `stat failed: ${err?.message ?? err}` }); continue; }
    if (st.size > maxBytes) {
      errors.push({ path: fullPath, message: `workflow file exceeds ${maxBytes} byte cap (${st.size} bytes); skipped` });
      continue;
    }
    let text: string;
    try { text = await deps.readFile(fullPath); }
    catch (err: any) { errors.push({ path: fullPath, message: `read failed: ${err?.message ?? err}` }); continue; }
    let meta;
    try { meta = extractMeta(text); }
    catch (e) {
      const msg = e instanceof MetaParseError ? e.message : (e as Error).message;
      errors.push({ path: fullPath, message: msg });
      continue;
    }
    const basename = fullPath.substring(fullPath.lastIndexOf("/") + 1).replace(/\.ts$/, "");
    if (meta.name !== basename) {
      errors.push({ path: fullPath, message: `meta.name '${meta.name}' must match filename basename '${basename}'` });
      continue;
    }
    if (seenNames.has(meta.name)) {
      errors.push({ path: fullPath, message: `duplicate workflow name '${meta.name}' within ${scope} scope; lexicographic-first wins; this file skipped` });
      continue;
    }
    seenNames.add(meta.name);
    out.push({ meta, source: text, sourcePath: fullPath, scope });
  }
  return out;
}

export async function loadFromDirs(input: LoaderInput): Promise<LoaderResult> {
  const errors: LoaderError[] = [];
  const maxBytes = input.maxFileBytes ?? DEFAULT_MAX_BYTES;
  const userMs = await loadOneScope(input.userDir, "user", input.deps, maxBytes, errors);
  const projectMs = await loadOneScope(input.projectDir, "project", input.deps, maxBytes, errors);

  const byName = new Map<string, WorkflowManifest>();
  for (const m of userMs) byName.set(m.meta.name, m);
  for (const m of projectMs) {
    if (byName.has(m.meta.name)) {
      const existing = byName.get(m.meta.name)!;
      errors.push({
        path: m.sourcePath!,
        message: `project-scope workflow '${m.meta.name}' shadows user-scope at ${existing.sourcePath}`,
      });
    }
    byName.set(m.meta.name, m);
  }
  return { manifests: [...byName.values()], errors };
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `cd plugins/llm-workflow && bun test test/loader.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-workflow/loader.ts plugins/llm-workflow/test/loader.test.ts
git commit -m "llm-workflow: add file-discovery loader"
```

---

## Task 11: RPC message types

**Files:**
- Create: `plugins/llm-workflow/rpc-types.ts`

- [ ] **Step 1: Write the module (no test — pure types)**

`plugins/llm-workflow/rpc-types.ts`:

```typescript
import type { WorkflowPhase } from "llm-contracts/public";

// host → worker
export interface BootMsg {
  type: "BOOT";
  runId: string;
  source: string;
  args: unknown;
  metaPhases: WorkflowPhase[];
  budgetTotal: number | null;
}
export interface CallResultMsg {
  type: "CALL_RESULT";
  callId: number;
  value: unknown;
}
export interface CallErrorMsg {
  type: "CALL_ERROR";
  callId: number;
  error: { name: string; message: string; stack?: string };
}
export interface CancelMsg {
  type: "CANCEL";
  reason: string;
}

// worker → host
export interface ReadyMsg { type: "READY"; }
export interface CallMsg {
  type: "CALL";
  callId: number;
  kind: "agent" | "log" | "phase" | "workflow" | "budgetRead";
  payload: unknown;
}
export interface DoneMsg {
  type: "DONE";
  value: unknown;
}
export interface WorkerErrorMsg {
  type: "WORKER_ERROR";
  error: { name: string; message: string; stack?: string };
}

export type HostToWorker = BootMsg | CallResultMsg | CallErrorMsg | CancelMsg;
export type WorkerToHost = ReadyMsg | CallMsg | DoneMsg | WorkerErrorMsg;

// Payload shapes for `CallMsg.payload` per `kind`:
export interface AgentCallPayload {
  prompt: string;
  label?: string;
  phase?: string;
  model?: string;
  agentType?: string;
  schema?: object;        // reserved (v1.1)
  isolation?: "worktree"; // reserved (v1.1)
}
export interface LogCallPayload { message: string; }
export interface PhaseCallPayload { phase: string; }
export interface WorkflowCallPayload { nameOrRef: string | { scriptPath: string }; args: unknown; }
export interface BudgetReadPayload { what: "spent" | "remaining" | "total"; }
```

- [ ] **Step 2: Verify it type-checks**

Run: `cd plugins/llm-workflow && bun test`
Expected: PASS (the module compiles when imported by later tasks; no tests of its own).

- [ ] **Step 3: Commit**

```bash
git add plugins/llm-workflow/rpc-types.ts
git commit -m "llm-workflow: add RPC message types"
```

---

## Task 12: Sandbox entry (Worker side)

**Files:**
- Create: `plugins/llm-workflow/primitives/parallel.ts` (worker-side helper source as string)
- Create: `plugins/llm-workflow/primitives/pipeline.ts` (worker-side helper source as string)
- Create: `plugins/llm-workflow/sandbox-entry.ts`

**Rationale:** `parallel` and `pipeline` run inside the worker. The simplest delivery is to inline their source as TypeScript strings into the worker's bootstrap. We export the source via separate `.ts` files so they can be unit-tested by `eval`-ing them in the host process.

- [ ] **Step 1: Write parallel.ts (worker-side source as string)**

`plugins/llm-workflow/primitives/parallel.ts`:

```typescript
// Source string evaluated inside the worker's bootstrap. Pure JS — no imports.
// Installed as the global `parallel`. Acquires the host-side semaphore implicitly
// via the per-thunk `agent()` calls inside each thunk.
export const PARALLEL_SRC = `
async function parallel(thunks) {
  const results = await Promise.all(thunks.map((t) => {
    try { return Promise.resolve(t()).catch(() => null); }
    catch { return Promise.resolve(null); }
  }));
  return results;
}
`;
```

- [ ] **Step 2: Write pipeline.ts (worker-side source as string)**

`plugins/llm-workflow/primitives/pipeline.ts`:

```typescript
// Pipeline: each item flows through stages independently — no barrier between stages.
// Stage signature: (prev, item, index) => Promise<any>. A stage that throws drops the
// item to null for the remainder of its chain.
export const PIPELINE_SRC = `
async function pipeline(items, ...stages) {
  return Promise.all(items.map(async (item, index) => {
    let prev = item;
    for (const stage of stages) {
      try { prev = await stage(prev, item, index); }
      catch { return null; }
      if (prev === null) return null;
    }
    return prev;
  }));
}
`;
```

- [ ] **Step 3: Write sandbox-entry.ts**

`plugins/llm-workflow/sandbox-entry.ts`:

```typescript
/// <reference lib="webworker" />
import type {
  HostToWorker, WorkerToHost, BootMsg, CallResultMsg, CallErrorMsg, CancelMsg,
  CallMsg, DoneMsg, WorkerErrorMsg, AgentCallPayload, LogCallPayload, PhaseCallPayload,
  WorkflowCallPayload, BudgetReadPayload,
} from "./rpc-types.ts";
import { PARALLEL_SRC } from "./primitives/parallel.ts";
import { PIPELINE_SRC } from "./primitives/pipeline.ts";

declare const self: DedicatedWorkerGlobalScope;

const ALLOW_KEYS = new Set<string>([
  "self","globalThis","console","JSON","Math","Promise","Array","Object",
  "String","Number","Boolean","RegExp","Error","TypeError","RangeError","SyntaxError",
  "Map","Set","WeakMap","WeakSet","Symbol","BigInt","Uint8Array","Int8Array","Uint16Array",
  "Int16Array","Uint32Array","Int32Array","Float32Array","Float64Array","ArrayBuffer",
  "Reflect","Proxy","Buffer","TextEncoder","TextDecoder",
  "queueMicrotask",
  "postMessage","addEventListener","removeEventListener","onmessage","onerror",
  "agent","parallel","pipeline","phase","log","workflow","args","budget",
]);

function curateGlobals(): void {
  const g = self as unknown as Record<string, unknown>;
  for (const k of Object.getOwnPropertyNames(g)) {
    if (!ALLOW_KEYS.has(k)) {
      try { delete g[k]; } catch { try { (g as any)[k] = undefined; } catch {} }
    }
  }
  for (const k of [
    "Bun","process","require","module","__dirname","__filename",
    "fetch","XMLHttpRequest","WebSocket","EventSource",
    "setInterval","setImmediate","setTimeout","clearTimeout",
    "eval","Function","import",
  ]) {
    try { (g as any)[k] = undefined; } catch {}
  }
  // Determinism guards: throw on Date.now / Math.random / argless `new Date()`.
  try {
    (Date as any).now = function blocked() { throw new Error("Date.now() is disabled in workflow sandbox (preserves resume determinism)"); };
    const OrigDate = Date;
    (globalThis as any).Date = function GuardedDate(this: any, ...rest: any[]) {
      if (rest.length === 0) throw new Error("argless `new Date()` is disabled in workflow sandbox");
      return new (OrigDate as any)(...rest);
    } as any;
    (globalThis as any).Date.UTC = OrigDate.UTC;
    (globalThis as any).Date.parse = OrigDate.parse;
    (globalThis as any).Date.now = function blocked() { throw new Error("Date.now() is disabled in workflow sandbox"); };
    (Math as any).random = function blocked() { throw new Error("Math.random() is disabled in workflow sandbox"); };
  } catch {}
  try {
    const FnCtor = (function(){}).constructor;
    if (FnCtor) (FnCtor as any).prototype.constructor = function blocked() { throw new Error("Function constructor disabled in workflow sandbox"); };
  } catch {}
}

// ----- RPC scaffolding -----
type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void };
const pending = new Map<number, Pending>();
let counter = 0;
function nextId(): number { return ++counter; }

function rpc<K extends CallMsg["kind"]>(kind: K, payload: unknown): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const callId = nextId();
    pending.set(callId, { resolve, reject });
    const msg: CallMsg = { type: "CALL", callId, kind, payload };
    (self as any).postMessage(msg);
  });
}

// ----- Console (drop-in noop; stdout not captured for workflows) -----
const makeConsole = () => ({
  log: (..._a: unknown[]) => {},
  info: (..._a: unknown[]) => {},
  debug: (..._a: unknown[]) => {},
  warn: (..._a: unknown[]) => {},
  error: (..._a: unknown[]) => {},
});

// ----- Bootstrapped on BOOT -----
const AsyncFunctionCtor: FunctionConstructor = (async function () {}).constructor as unknown as FunctionConstructor;

const BunTranspilerCtor: (new (opts: { loader: string }) => { transformSync(s: string): string }) | undefined =
  (globalThis as any).Bun?.Transpiler;
function transpileToJs(code: string): string {
  if (!BunTranspilerCtor) return code;
  try { return new BunTranspilerCtor({ loader: "ts" }).transformSync(code); }
  catch { return code; }
}

function installPrimitives(boot: BootMsg): void {
  // RPC-backed primitives.
  const agent = (prompt: string, opts: any = {}) => rpc("agent", { prompt, ...opts } satisfies AgentCallPayload);
  const log = (message: string) => { void rpc("log", { message } satisfies LogCallPayload); };
  const phase = (p: string) => { void rpc("phase", { phase: p } satisfies PhaseCallPayload); };
  const workflow = (nameOrRef: any, args: unknown) => rpc("workflow", { nameOrRef, args } satisfies WorkflowCallPayload);

  const budget = {
    total: boot.budgetTotal,
    async spent() { return await rpc("budgetRead", { what: "spent" } satisfies BudgetReadPayload) as number; },
    async remaining() { return await rpc("budgetRead", { what: "remaining" } satisfies BudgetReadPayload) as number; },
  };

  const def = (name: string, value: unknown) => {
    try {
      Object.defineProperty(globalThis as any, name, { value, configurable: false, writable: false, enumerable: true });
    } catch {
      (globalThis as any)[name] = value;
    }
  };
  def("agent", agent);
  def("log", log);
  def("phase", phase);
  def("workflow", workflow);
  def("budget", budget);
  def("args", boot.args);
}

self.addEventListener("message", async (ev: MessageEvent<HostToWorker>) => {
  const msg = ev.data;
  if (msg.type === "CALL_RESULT") {
    const p = pending.get(msg.callId);
    if (!p) return;
    pending.delete(msg.callId);
    p.resolve(msg.value);
    return;
  }
  if (msg.type === "CALL_ERROR") {
    const p = pending.get(msg.callId);
    if (!p) return;
    pending.delete(msg.callId);
    p.reject(Object.assign(new Error(msg.error?.message ?? "rpc error"), { name: msg.error?.name ?? "Error" }));
    return;
  }
  if (msg.type === "CANCEL") {
    try { self.close(); } catch {}
    return;
  }
  if (msg.type === "BOOT") {
    curateGlobals();
    (globalThis as any).console = makeConsole();
    installPrimitives(msg);

    // Install parallel/pipeline (worker-side JS) as globals.
    try {
      // eslint-disable-next-line no-new-func
      const installer = new (AsyncFunctionCtor as any)(
        `${PARALLEL_SRC}\n${PIPELINE_SRC}\nglobalThis.parallel = parallel;\nglobalThis.pipeline = pipeline;`,
      );
      await installer();
    } catch (e) {
      const err: WorkerErrorMsg = { type: "WORKER_ERROR", error: { name: (e as Error).name ?? "Error", message: (e as Error).message ?? String(e) } };
      (self as any).postMessage(err);
      return;
    }

    // Notify host we're ready to receive CALL_RESULT for in-flight rpc (none yet).
    (self as any).postMessage({ type: "READY" } satisfies WorkerToHost);

    // Evaluate the user script.
    try {
      const jsCode = transpileToJs(msg.source);
      const fn = new (AsyncFunctionCtor as any)(`${jsCode}`);
      const value = await fn();
      (self as any).postMessage({ type: "DONE", value } satisfies DoneMsg);
    } catch (err) {
      const e = err as Error;
      (self as any).postMessage({
        type: "WORKER_ERROR",
        error: { name: e.name ?? "Error", message: e.message ?? String(err), stack: e.stack },
      } satisfies WorkerErrorMsg);
    }
  }
});
```

- [ ] **Step 4: Commit (no test yet — sandbox-entry is exercised in integration tests later)**

```bash
git add plugins/llm-workflow/sandbox-entry.ts plugins/llm-workflow/primitives/parallel.ts plugins/llm-workflow/primitives/pipeline.ts
git commit -m "llm-workflow: add sandbox entry (Worker side)"
```

---

## Task 13: Sandbox host

**Files:**
- Create: `plugins/llm-workflow/sandbox-host.ts`
- Create: `plugins/llm-workflow/test/_helpers.ts` (shared test fakes — first usage here, expanded in later tasks)

- [ ] **Step 1: Create test helpers**

`plugins/llm-workflow/test/_helpers.ts`:

```typescript
// Shared fakes used across unit + integration tests.
import type { DriverService, RunConversationInput, RunConversationOutput, ChatMessage } from "llm-contracts/public";

export function fakeDriver(opts: {
  reply?: (input: RunConversationInput) => Promise<RunConversationOutput>;
} = {}): { driver: DriverService; calls: RunConversationInput[] } {
  const calls: RunConversationInput[] = [];
  const driver: DriverService = {
    async runConversation(input) {
      calls.push(input);
      if (opts.reply) return opts.reply(input);
      const msg: ChatMessage = { role: "assistant", content: `ok:${input.userMessage && "content" in input.userMessage ? input.userMessage.content : ""}` };
      return { finalMessage: msg, usage: { promptTokens: 10, completionTokens: 5 } };
    },
  };
  return { driver, calls };
}

export function counter() {
  let n = 0;
  return { next: () => ++n, peek: () => n };
}

export interface EventCapture {
  on: (name: string, fn: (p: unknown) => void) => void;
  emit: (name: string, p: unknown) => void;
  emitted: Array<{ name: string; payload: unknown }>;
}
export function eventBus(): EventCapture {
  const subs = new Map<string, Array<(p: unknown) => void>>();
  const emitted: Array<{ name: string; payload: unknown }> = [];
  return {
    on(name, fn) {
      const list = subs.get(name) ?? [];
      list.push(fn); subs.set(name, list);
    },
    emit(name, p) {
      emitted.push({ name, payload: p });
      for (const fn of subs.get(name) ?? []) fn(p);
    },
    emitted,
  };
}
```

- [ ] **Step 2: Write sandbox-host.ts**

`plugins/llm-workflow/sandbox-host.ts`:

```typescript
import type {
  BootMsg, CallMsg, CallResultMsg, CallErrorMsg, CancelMsg,
  WorkerToHost, HostToWorker, AgentCallPayload, LogCallPayload, PhaseCallPayload,
  WorkflowCallPayload, BudgetReadPayload,
} from "./rpc-types.ts";
import type { WorkflowMeta } from "llm-contracts/public";
import { WorkerSpawnError, WorkflowTimeoutError, WorkflowAbortedError, ScriptError } from "./errors.ts";

const ENTRY_URL = (() => {
  const here = new URL(".", import.meta.url);
  const root = here.pathname.endsWith("/dist/") ? new URL("..", here) : here;
  return new URL("./sandbox-entry.ts", root).href;
})();

export interface HostCallbacks {
  onAgentCall(payload: AgentCallPayload): Promise<unknown>;
  onLog(payload: LogCallPayload): void;
  onPhase(payload: PhaseCallPayload): void;
  onWorkflowCall(payload: WorkflowCallPayload): Promise<unknown>;
  onBudgetRead(payload: BudgetReadPayload): number;
}

export interface SandboxRunArgs {
  runId: string;
  source: string;
  meta: WorkflowMeta;
  args: unknown;
  budgetTotal: number | null;
  timeoutMs: number;
  gracefulShutdownMs: number;
  signal: AbortSignal;
  callbacks: HostCallbacks;
}

export interface SandboxRunResult {
  ok: boolean;
  value?: unknown;
  error?: { name: string; message: string; stack?: string };
}

export async function runInSandbox(args: SandboxRunArgs): Promise<SandboxRunResult> {
  let worker: any;
  try {
    worker = new (globalThis as any).Worker(ENTRY_URL, { type: "module" });
  } catch (e) {
    return { ok: false, error: { name: "WorkerSpawnError", message: (e as Error).message } };
  }

  let settled = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let gracefulHandle: ReturnType<typeof setTimeout> | null = null;

  const cleanup = () => {
    if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = null; }
    if (gracefulHandle) { clearTimeout(gracefulHandle); gracefulHandle = null; }
    try { worker.terminate(); } catch {}
  };

  function postCancel(reason: string) {
    try {
      worker.postMessage({ type: "CANCEL", reason } satisfies CancelMsg as HostToWorker);
    } catch {}
    gracefulHandle = setTimeout(() => { try { worker.terminate(); } catch {} }, args.gracefulShutdownMs);
  }

  return new Promise<SandboxRunResult>((resolve) => {
    const onAbort = () => {
      if (settled) return;
      settled = true;
      postCancel("aborted");
      resolve({ ok: false, error: { name: "WorkflowAbortedError", message: "workflow aborted" } });
      cleanup();
    };
    if (args.signal.aborted) { onAbort(); return; }
    args.signal.addEventListener("abort", onAbort, { once: true });

    timeoutHandle = setTimeout(() => {
      if (settled) return;
      settled = true;
      postCancel("timeout");
      resolve({ ok: false, error: { name: "WorkflowTimeoutError", message: `workflow did not complete within ${args.timeoutMs}ms` } });
      args.signal.removeEventListener("abort", onAbort);
      cleanup();
    }, args.timeoutMs);

    worker.onmessage = async (ev: MessageEvent<WorkerToHost>) => {
      const msg = ev.data;
      if (msg.type === "READY") return;
      if (msg.type === "CALL") {
        const { callId, kind, payload } = msg;
        try {
          let value: unknown;
          if (kind === "agent")       value = await args.callbacks.onAgentCall(payload as AgentCallPayload);
          else if (kind === "log")    { args.callbacks.onLog(payload as LogCallPayload); value = undefined; }
          else if (kind === "phase")  { args.callbacks.onPhase(payload as PhaseCallPayload); value = undefined; }
          else if (kind === "workflow") value = await args.callbacks.onWorkflowCall(payload as WorkflowCallPayload);
          else if (kind === "budgetRead") value = args.callbacks.onBudgetRead(payload as BudgetReadPayload);
          else throw new Error(`unknown CALL kind: ${kind}`);
          if (!settled) {
            try { worker.postMessage({ type: "CALL_RESULT", callId, value } satisfies CallResultMsg as HostToWorker); }
            catch {}
          }
        } catch (err) {
          if (!settled) {
            const e = err as Error;
            try {
              worker.postMessage({
                type: "CALL_ERROR",
                callId,
                error: { name: e.name ?? "Error", message: e.message ?? String(err), stack: e.stack },
              } satisfies CallErrorMsg as HostToWorker);
            } catch {}
          }
        }
        return;
      }
      if (msg.type === "DONE") {
        if (settled) return;
        settled = true;
        args.signal.removeEventListener("abort", onAbort);
        cleanup();
        resolve({ ok: true, value: msg.value });
        return;
      }
      if (msg.type === "WORKER_ERROR") {
        if (settled) return;
        settled = true;
        args.signal.removeEventListener("abort", onAbort);
        cleanup();
        resolve({ ok: false, error: msg.error });
        return;
      }
    };

    worker.onerror = (e: ErrorEvent) => {
      if (settled) return;
      settled = true;
      args.signal.removeEventListener("abort", onAbort);
      cleanup();
      resolve({ ok: false, error: { name: "WorkerCrash", message: e?.message ?? "worker crashed" } });
    };

    const boot: BootMsg = {
      type: "BOOT",
      runId: args.runId,
      source: args.source,
      args: args.args,
      metaPhases: args.meta.phases ?? [],
      budgetTotal: args.budgetTotal,
    };
    try { worker.postMessage(boot satisfies HostToWorker); }
    catch (e) {
      settled = true;
      cleanup();
      resolve({ ok: false, error: { name: "WorkerSpawnError", message: (e as Error).message } });
    }
  });
}

// Re-export error names for runner.ts convenience.
export { WorkerSpawnError, WorkflowTimeoutError, WorkflowAbortedError, ScriptError };
```

- [ ] **Step 3: Commit (real exercise is in integration test, Task 22)**

```bash
git add plugins/llm-workflow/sandbox-host.ts plugins/llm-workflow/test/_helpers.ts
git commit -m "llm-workflow: add sandbox host (RPC dispatch)"
```

---

## Task 14: Primitive — `agent()` host-side

**Files:**
- Create: `plugins/llm-workflow/primitives/agent.ts`
- Create: `plugins/llm-workflow/test/primitives-agent.test.ts`

- [ ] **Step 1: Write the failing test**

`plugins/llm-workflow/test/primitives-agent.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import { makeAgentCallback } from "../primitives/agent.ts";
import { makeSemaphore } from "../semaphore.ts";
import { makeBudget } from "../budget.ts";
import { fakeDriver, eventBus, counter } from "./_helpers.ts";
import type { AgentsRegistryService, AgentManifest } from "llm-contracts/public";

function makeAgentsRegistry(manifests: AgentManifest[]): AgentsRegistryService {
  const map = new Map(manifests.map((m) => [m.name, m]));
  return {
    list: () => [...map.values()],
    register: () => { throw new Error("not used in test"); },
  } as AgentsRegistryService;
}

describe("agent() host-side callback", () => {
  it("invokes driver and returns assistant text", async () => {
    const { driver, calls } = fakeDriver();
    const sem = makeSemaphore({ maxConcurrency: 4, maxLifetimeAgents: 100 });
    const budget = makeBudget({ total: null });
    const bus = eventBus();
    const cb = makeAgentCallback({
      runId: "r1",
      driver,
      agentsRegistry: undefined,
      semaphore: sem,
      budget,
      emit: (e, p) => bus.emit(e, p),
      sessionIdProvider: () => "sess",
      agentIdCounter: counter(),
    });
    const text = await cb({ prompt: "hello" });
    expect(text).toBe("ok:hello");
    expect(calls.length).toBe(1);
    expect(calls[0]!.systemPrompt).toBe("");
    expect(budget.spent()).toBe(5);
    expect(bus.emitted.map((e) => e.name)).toEqual(["workflow:agent-start", "workflow:agent-end"]);
  });

  it("overlays agentType from agents:registry when present", async () => {
    const { driver, calls } = fakeDriver();
    const reg = makeAgentsRegistry([{
      name: "reviewer",
      description: "code reviewer",
      systemPrompt: "You are a reviewer.",
      toolFilter: { names: ["read_file"] },
    }]);
    const cb = makeAgentCallback({
      runId: "r1",
      driver,
      agentsRegistry: reg,
      semaphore: makeSemaphore({ maxConcurrency: 4, maxLifetimeAgents: 100 }),
      budget: makeBudget({ total: null }),
      emit: () => {},
      sessionIdProvider: () => "sess",
      agentIdCounter: counter(),
    });
    await cb({ prompt: "review this", agentType: "reviewer" });
    expect(calls[0]!.systemPrompt).toBe("You are a reviewer.");
    expect(calls[0]!.toolFilter?.names).toEqual(["read_file"]);
  });

  it("throws if agentType is unknown", async () => {
    const cb = makeAgentCallback({
      runId: "r1",
      driver: fakeDriver().driver,
      agentsRegistry: makeAgentsRegistry([]),
      semaphore: makeSemaphore({ maxConcurrency: 4, maxLifetimeAgents: 100 }),
      budget: makeBudget({ total: null }),
      emit: () => {},
      sessionIdProvider: () => "sess",
      agentIdCounter: counter(),
    });
    await expect(cb({ prompt: "x", agentType: "missing" }))
      .rejects.toThrow(/unknown agentType/);
  });

  it("accumulates budget tokens from driver usage", async () => {
    const budget = makeBudget({ total: null });
    const cb = makeAgentCallback({
      runId: "r1",
      driver: fakeDriver({
        reply: async () => ({ finalMessage: { role: "assistant", content: "x" }, usage: { promptTokens: 1, completionTokens: 42 } }),
      }).driver,
      agentsRegistry: undefined,
      semaphore: makeSemaphore({ maxConcurrency: 4, maxLifetimeAgents: 100 }),
      budget,
      emit: () => {},
      sessionIdProvider: () => "sess",
      agentIdCounter: counter(),
    });
    await cb({ prompt: "x" });
    expect(budget.spent()).toBe(42);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd plugins/llm-workflow && bun test test/primitives-agent.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement primitives/agent.ts**

`plugins/llm-workflow/primitives/agent.ts`:

```typescript
import type {
  DriverService, AgentsRegistryService, ChatMessage,
} from "llm-contracts/public";
import type { AgentCallPayload } from "../rpc-types.ts";
import type { Semaphore } from "../semaphore.ts";
import type { Budget } from "../budget.ts";

export interface AgentCallbackDeps {
  runId: string;
  driver: DriverService;
  agentsRegistry: AgentsRegistryService | undefined;
  semaphore: Semaphore;
  budget: Budget;
  emit: (event: string, payload: unknown) => void;
  sessionIdProvider: () => string;
  agentIdCounter: { next: () => number };
  parentTurnId?: string;
  signal?: AbortSignal;
}

export function makeAgentCallback(deps: AgentCallbackDeps): (p: AgentCallPayload) => Promise<string | null> {
  return async (p: AgentCallPayload): Promise<string | null> => {
    deps.budget.assertNotExceeded();
    await deps.semaphore.acquire();
    const agentId = `a${deps.agentIdCounter.next()}`;
    const userMessage: ChatMessage = { role: "user", content: p.prompt };
    let systemPrompt = "";
    let toolFilter: { names?: string[]; tags?: string[] } | undefined = undefined;
    if (p.agentType) {
      const reg = deps.agentsRegistry;
      const manifest = reg?.list().find((m) => m.name === p.agentType);
      if (!manifest) {
        deps.semaphore.release();
        throw new Error(`unknown agentType '${p.agentType}'`);
      }
      systemPrompt = manifest.systemPrompt;
      toolFilter = manifest.toolFilter;
    }

    deps.emit("workflow:agent-start", {
      runId: deps.runId, agentId, label: p.label ?? p.agentType ?? "agent",
      phase: p.phase, model: p.model, prompt: p.prompt,
    });

    try {
      const out = await deps.driver.runConversation({
        systemPrompt,
        sessionId: deps.sessionIdProvider(),
        userMessage,
        toolFilter,
        model: p.model,
        parentTurnId: deps.parentTurnId,
        signal: deps.signal,
        trigger: "agent",
      });
      const tokens = out.usage?.completionTokens ?? 0;
      deps.budget.add(tokens);
      const finalText = typeof out.finalMessage.content === "string" ? out.finalMessage.content : "";
      deps.emit("workflow:agent-end", { runId: deps.runId, agentId, ok: true, tokensSpent: tokens });
      return finalText;
    } catch (err) {
      const e = err as Error;
      deps.emit("workflow:agent-end", {
        runId: deps.runId, agentId, ok: false, tokensSpent: 0,
        error: { name: e.name ?? "Error", message: e.message ?? String(err) },
      });
      throw err;
    } finally {
      deps.semaphore.release();
    }
  };
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `cd plugins/llm-workflow && bun test test/primitives-agent.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-workflow/primitives/agent.ts plugins/llm-workflow/test/primitives-agent.test.ts
git commit -m "llm-workflow: add agent() host-side primitive"
```

---

## Task 15: Primitives — `phase()`, `log()`, `workflow()` host-side

**Files:**
- Create: `plugins/llm-workflow/primitives/phase.ts`
- Create: `plugins/llm-workflow/primitives/workflow.ts`
- Create: `plugins/llm-workflow/test/primitives-phase.test.ts`
- Create: `plugins/llm-workflow/test/primitives-workflow.test.ts`

- [ ] **Step 1: Write phase/log test**

`plugins/llm-workflow/test/primitives-phase.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import { makePhaseCallback, makeLogCallback } from "../primitives/phase.ts";
import { eventBus } from "./_helpers.ts";

describe("phase() / log()", () => {
  it("phase emits workflow:phase with runId", () => {
    const bus = eventBus();
    const cb = makePhaseCallback({ runId: "r1", emit: (e, p) => bus.emit(e, p) });
    cb({ phase: "Verify" });
    expect(bus.emitted).toEqual([{ name: "workflow:phase", payload: { runId: "r1", phase: "Verify" } }]);
  });
  it("log emits workflow:log with runId", () => {
    const bus = eventBus();
    const cb = makeLogCallback({ runId: "r1", emit: (e, p) => bus.emit(e, p) });
    cb({ message: "found 3 bugs" });
    expect(bus.emitted).toEqual([{ name: "workflow:log", payload: { runId: "r1", message: "found 3 bugs" } }]);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd plugins/llm-workflow && bun test test/primitives-phase.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement phase.ts**

`plugins/llm-workflow/primitives/phase.ts`:

```typescript
import type { LogCallPayload, PhaseCallPayload } from "../rpc-types.ts";

export interface PhaseDeps { runId: string; emit: (event: string, payload: unknown) => void; }

export function makePhaseCallback(deps: PhaseDeps): (p: PhaseCallPayload) => void {
  return (p) => deps.emit("workflow:phase", { runId: deps.runId, phase: p.phase });
}

export function makeLogCallback(deps: PhaseDeps): (p: LogCallPayload) => void {
  return (p) => deps.emit("workflow:log", { runId: deps.runId, message: p.message });
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `cd plugins/llm-workflow && bun test test/primitives-phase.test.ts`
Expected: PASS.

- [ ] **Step 5: Write workflow() test**

`plugins/llm-workflow/test/primitives-workflow.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import { makeWorkflowCallback } from "../primitives/workflow.ts";
import { WorkflowNestingError } from "../errors.ts";

describe("workflow() host-side", () => {
  it("delegates to runChildWorkflow when depth = 0", async () => {
    let called: { nameOrRef: any; args: any } | null = null;
    const cb = makeWorkflowCallback({
      depth: 0,
      runChildWorkflow: async (nameOrRef, args) => { called = { nameOrRef, args }; return "child-result"; },
    });
    const r = await cb({ nameOrRef: "foo", args: { x: 1 } });
    expect(r).toBe("child-result");
    expect(called).toEqual({ nameOrRef: "foo", args: { x: 1 } });
  });

  it("throws WorkflowNestingError at depth = 1", async () => {
    const cb = makeWorkflowCallback({
      depth: 1,
      runChildWorkflow: async () => "should not run",
    });
    await expect(cb({ nameOrRef: "foo", args: undefined }))
      .rejects.toBeInstanceOf(WorkflowNestingError);
  });
});
```

- [ ] **Step 6: Run, expect FAIL**

Run: `cd plugins/llm-workflow && bun test test/primitives-workflow.test.ts`
Expected: FAIL.

- [ ] **Step 7: Implement primitives/workflow.ts**

`plugins/llm-workflow/primitives/workflow.ts`:

```typescript
import type { WorkflowCallPayload } from "../rpc-types.ts";
import { WorkflowNestingError } from "../errors.ts";

export interface WorkflowCallDeps {
  depth: number;
  runChildWorkflow: (nameOrRef: string | { scriptPath: string }, args: unknown) => Promise<unknown>;
}

export function makeWorkflowCallback(deps: WorkflowCallDeps): (p: WorkflowCallPayload) => Promise<unknown> {
  return async (p) => {
    if (deps.depth >= 1) {
      throw new WorkflowNestingError("nested workflow() depth > 1 is not allowed in v1");
    }
    return deps.runChildWorkflow(p.nameOrRef, p.args);
  };
}
```

- [ ] **Step 8: Run, expect PASS**

Run: `cd plugins/llm-workflow && bun test test/primitives-workflow.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add plugins/llm-workflow/primitives/phase.ts plugins/llm-workflow/primitives/workflow.ts plugins/llm-workflow/test/primitives-phase.test.ts plugins/llm-workflow/test/primitives-workflow.test.ts
git commit -m "llm-workflow: add phase/log/workflow host-side primitives"
```

---

## Task 16: Runner — single workflow orchestrator

**Files:**
- Create: `plugins/llm-workflow/runner.ts`
- Create: `plugins/llm-workflow/test/runner.test.ts`

- [ ] **Step 1: Write the failing test**

`plugins/llm-workflow/test/runner.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import { makeRunner } from "../runner.ts";
import { fakeDriver, eventBus } from "./_helpers.ts";

describe("runner", () => {
  it("static-parse failure short-circuits with MetaParseError; no workflow:start emitted", async () => {
    const bus = eventBus();
    const runner = makeRunner({
      driver: fakeDriver().driver,
      agentsRegistry: undefined,
      emit: (e, p) => bus.emit(e, p),
      runByName: async () => { throw new Error("not used"); },
      timeoutMs: 5000,
      gracefulShutdownMs: 100,
      maxConcurrency: 4,
      maxLifetimeAgents: 100,
      sessionIdProvider: () => "sess",
    });
    const r = await runner.runInline("// no meta here", {});
    expect(r.ok).toBe(false);
    expect(r.error?.name).toBe("MetaParseError");
    expect(bus.emitted.find((e) => e.name === "workflow:start")).toBeUndefined();
    expect(bus.emitted.find((e) => e.name === "workflow:end")).toBeDefined();
  });

  it("emits workflow:start and workflow:end with matching runId", async () => {
    const bus = eventBus();
    const runner = makeRunner({
      driver: fakeDriver().driver,
      agentsRegistry: undefined,
      emit: (e, p) => bus.emit(e, p),
      runByName: async () => { throw new Error("not used"); },
      timeoutMs: 5000,
      gracefulShutdownMs: 100,
      maxConcurrency: 4,
      maxLifetimeAgents: 100,
      sessionIdProvider: () => "sess",
    });
    const src = `export const meta = { name: "demo", description: "d" };\n`;
    const r = await runner.runInline(src, {});
    const startPayload = bus.emitted.find((e) => e.name === "workflow:start")?.payload as any;
    const endPayload = bus.emitted.find((e) => e.name === "workflow:end")?.payload as any;
    expect(startPayload?.runId).toBe(r.runId);
    expect(endPayload?.runId).toBe(r.runId);
    expect(endPayload?.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd plugins/llm-workflow && bun test test/runner.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement runner.ts**

`plugins/llm-workflow/runner.ts`:

```typescript
import type {
  DriverService, AgentsRegistryService,
  WorkflowManifest, WorkflowMeta, RunResult,
} from "llm-contracts/public";
import { extractMeta } from "./meta-parse.ts";
import { MetaParseError } from "./errors.ts";
import { makeSemaphore, resolveMaxConcurrency } from "./semaphore.ts";
import { makeBudget } from "./budget.ts";
import { runInSandbox, type HostCallbacks } from "./sandbox-host.ts";
import { makeAgentCallback } from "./primitives/agent.ts";
import { makePhaseCallback, makeLogCallback } from "./primitives/phase.ts";
import { makeWorkflowCallback } from "./primitives/workflow.ts";
import { counter } from "./test/_helpers.ts"; // reused — pure utility, no test deps
// Note: the import path above works because `_helpers.ts` only exports `counter` as a pure function.

export interface RunnerDeps {
  driver: DriverService;
  agentsRegistry: AgentsRegistryService | undefined;
  emit: (event: string, payload: unknown) => void;
  runByName: (name: string, opts?: { args?: unknown; signal?: AbortSignal }) => Promise<RunResult>;
  timeoutMs: number;
  gracefulShutdownMs: number;
  maxConcurrency: number;
  maxLifetimeAgents: number;
  sessionIdProvider: () => string;
}

export interface Runner {
  runInline(source: string, opts: { args?: unknown; budgetTotal?: number | null; signal?: AbortSignal; depth?: number }): Promise<RunResult>;
  runManifest(manifest: WorkflowManifest, opts: { args?: unknown; budgetTotal?: number | null; signal?: AbortSignal; depth?: number }): Promise<RunResult>;
}

let runIdCounter = 0;
function nextRunId(): string { return `wf_${(++runIdCounter).toString(36)}_${process.pid}`; }

export function makeRunner(deps: RunnerDeps): Runner {
  const cpus = (globalThis as any).navigator?.hardwareConcurrency ?? 4;
  const maxConc = resolveMaxConcurrency(deps.maxConcurrency, cpus);

  async function runMeta(source: string, meta: WorkflowMeta, opts: { args?: unknown; budgetTotal?: number | null; signal?: AbortSignal; depth?: number }): Promise<RunResult> {
    const runId = nextRunId();
    const startedAt = performance.now();
    const sem = makeSemaphore({ maxConcurrency: maxConc, maxLifetimeAgents: deps.maxLifetimeAgents });
    const budget = makeBudget({ total: opts.budgetTotal ?? null });
    const ac = new AbortController();
    if (opts.signal) {
      if (opts.signal.aborted) ac.abort();
      else opts.signal.addEventListener("abort", () => ac.abort(), { once: true });
    }

    deps.emit("workflow:start", { runId, name: meta.name, phases: meta.phases ?? [], inline: !meta.name.startsWith("runtime:") });

    const callbacks: HostCallbacks = {
      onAgentCall: makeAgentCallback({
        runId, driver: deps.driver, agentsRegistry: deps.agentsRegistry,
        semaphore: sem, budget, emit: deps.emit,
        sessionIdProvider: deps.sessionIdProvider,
        agentIdCounter: counter(),
        signal: ac.signal,
      }),
      onLog: makeLogCallback({ runId, emit: deps.emit }),
      onPhase: makePhaseCallback({ runId, emit: deps.emit }),
      onWorkflowCall: makeWorkflowCallback({
        depth: opts.depth ?? 0,
        runChildWorkflow: async (nameOrRef, childArgs) => {
          if (typeof nameOrRef !== "string") {
            throw new Error("workflow({scriptPath}) is reserved (v1.1); pass a name string");
          }
          const child = await deps.runByName(nameOrRef, { args: childArgs, signal: ac.signal });
          if (!child.ok) throw Object.assign(new Error(child.error?.message ?? "child workflow failed"), { name: child.error?.name ?? "Error" });
          return child.value;
        },
      }),
      onBudgetRead: ({ what }) => {
        if (what === "spent") return budget.spent();
        if (what === "remaining") return budget.remaining();
        return budget.total ?? 0;
      },
    };

    const result = await runInSandbox({
      runId, source, meta,
      args: opts.args, budgetTotal: opts.budgetTotal ?? null,
      timeoutMs: deps.timeoutMs, gracefulShutdownMs: deps.gracefulShutdownMs,
      signal: ac.signal, callbacks,
    });

    const durationMs = Math.round(performance.now() - startedAt);
    const final: RunResult = result.ok
      ? { runId, ok: true, value: result.value, tokensSpent: budget.spent(), agentCount: sem.lifetime(), durationMs }
      : { runId, ok: false, error: result.error ?? { name: "ScriptError", message: "unknown" }, tokensSpent: budget.spent(), agentCount: sem.lifetime(), durationMs };

    deps.emit("workflow:end", { runId, ok: final.ok, value: final.value, error: final.error, tokensSpent: final.tokensSpent, agentCount: final.agentCount, durationMs });
    return final;
  }

  return {
    async runInline(source, opts) {
      let meta;
      try { meta = extractMeta(source); }
      catch (e) {
        const err = e instanceof MetaParseError ? e : new MetaParseError((e as Error).message);
        const runId = nextRunId();
        const result: RunResult = { runId, ok: false, error: { name: err.name, message: err.message }, tokensSpent: 0, agentCount: 0, durationMs: 0 };
        deps.emit("workflow:end", { runId, ok: false, error: result.error, tokensSpent: 0, agentCount: 0, durationMs: 0 });
        return result;
      }
      return runMeta(source, meta, opts);
    },
    async runManifest(manifest, opts) {
      return runMeta(manifest.source, manifest.meta, opts);
    },
  };
}
```

- [ ] **Step 4: Refactor _helpers.ts dependency**

The runner imports `counter` from `test/_helpers.ts`. Move `counter` into a non-test module so prod code doesn't import from `test/`.

Edit `plugins/llm-workflow/test/_helpers.ts`: remove the `counter` export.
Edit `plugins/llm-workflow/test/_helpers.ts`: at the top, re-export from a new util module:

```typescript
export { counter } from "../util-counter.ts";
```

Create `plugins/llm-workflow/util-counter.ts`:

```typescript
export function counter() {
  let n = 0;
  return { next: () => ++n, peek: () => n };
}
```

Edit `plugins/llm-workflow/runner.ts` — replace the `import { counter } from "./test/_helpers.ts";` line with:

```typescript
import { counter } from "./util-counter.ts";
```

- [ ] **Step 5: Run, expect PASS**

Run: `cd plugins/llm-workflow && bun test test/runner.test.ts`
Expected: PASS.

- [ ] **Step 6: Run full suite to verify no regression**

Run: `cd plugins/llm-workflow && bun test`
Expected: All prior tests still PASS.

- [ ] **Step 7: Commit**

```bash
git add plugins/llm-workflow/runner.ts plugins/llm-workflow/util-counter.ts plugins/llm-workflow/test/_helpers.ts plugins/llm-workflow/test/runner.test.ts
git commit -m "llm-workflow: add runner (single workflow orchestrator)"
```

---

## Task 17: Engine — public surface

**Files:**
- Create: `plugins/llm-workflow/engine.ts`
- Create: `plugins/llm-workflow/test/engine.test.ts`

- [ ] **Step 1: Write the failing test**

`plugins/llm-workflow/test/engine.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import { makeEngine } from "../engine.ts";
import { makeRegistry, makeRegistryHandle } from "../registry.ts";
import { makeRunner } from "../runner.ts";
import { fakeDriver, eventBus } from "./_helpers.ts";
import { WorkflowNotFoundError, WorkflowRegistryLoadingError } from "../errors.ts";

function makeEngineFixture() {
  const bus = eventBus();
  const reg = makeRegistryHandle(makeRegistry([
    { meta: { name: "hello", description: "hi" }, source: `export const meta = { name: "hello", description: "hi" };\n`, scope: "user" },
  ]));
  const driver = fakeDriver().driver;
  let ready = true;
  const isReady = () => ready;
  const setReady = (v: boolean) => { ready = v; };
  const runner = makeRunner({
    driver, agentsRegistry: undefined,
    emit: (e, p) => bus.emit(e, p),
    runByName: async (n, opts) => engine.runByName(n, opts),
    timeoutMs: 5000, gracefulShutdownMs: 100,
    maxConcurrency: 4, maxLifetimeAgents: 100,
    sessionIdProvider: () => "sess",
  });
  const engine: any = makeEngine({ registry: reg, runner, isReady });
  return { engine, bus, setReady };
}

describe("engine", () => {
  it("list/get delegates to registry handle", () => {
    const { engine } = makeEngineFixture();
    expect(engine.list().map((m: any) => m.meta.name)).toEqual(["hello"]);
    expect(engine.get("hello")?.meta.name).toBe("hello");
    expect(engine.get("nope")).toBeUndefined();
  });

  it("runByName fails with WorkflowNotFoundError for unknown name", async () => {
    const { engine } = makeEngineFixture();
    const r = await engine.runByName("missing");
    expect(r.ok).toBe(false);
    expect(r.error?.name).toBe("WorkflowNotFoundError");
  });

  it("runByName fails with WorkflowRegistryLoadingError while not ready", async () => {
    const { engine, setReady } = makeEngineFixture();
    setReady(false);
    const r = await engine.runByName("hello");
    expect(r.error?.name).toBe("WorkflowRegistryLoadingError");
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd plugins/llm-workflow && bun test test/engine.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement engine.ts**

`plugins/llm-workflow/engine.ts`:

```typescript
import type { WorkflowRegistryService, RunOptions, RunResult, WorkflowManifest } from "llm-contracts/public";
import type { RegistryHandle } from "./registry.ts";
import type { Runner } from "./runner.ts";
import { WorkflowNotFoundError, WorkflowRegistryLoadingError } from "./errors.ts";

export interface EngineDeps {
  registry: RegistryHandle;
  runner: Runner;
  isReady: () => boolean;
}

export function makeEngine(deps: EngineDeps): WorkflowRegistryService {
  return {
    list() { return deps.registry.service.list(); },
    get(name) { return deps.registry.service.get(name); },
    register(manifest: WorkflowManifest) { return deps.registry.service.register(manifest); },

    async runInline(script, opts: RunOptions = {}) {
      return deps.runner.runInline(script, { args: opts.args, signal: opts.signal });
    },

    async runByName(name, opts: RunOptions = {}) {
      if (!deps.isReady()) {
        const e = new WorkflowRegistryLoadingError("workflow registry still loading; retry");
        return { runId: "<unstarted>", ok: false, error: { name: e.name, message: e.message }, tokensSpent: 0, agentCount: 0, durationMs: 0 };
      }
      const manifest = deps.registry.service.get(name);
      if (!manifest) {
        const e = new WorkflowNotFoundError(`workflow '${name}' not found`);
        return { runId: "<unstarted>", ok: false, error: { name: e.name, message: e.message }, tokensSpent: 0, agentCount: 0, durationMs: 0 };
      }
      return deps.runner.runManifest(manifest, { args: opts.args, signal: opts.signal });
    },
  };
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `cd plugins/llm-workflow && bun test test/engine.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-workflow/engine.ts plugins/llm-workflow/test/engine.test.ts
git commit -m "llm-workflow: add engine (public surface)"
```

---

## Task 18: Workflow tool registration

**Files:**
- Create: `plugins/llm-workflow/tool.ts`
- Create: `plugins/llm-workflow/test/tool.test.ts`

- [ ] **Step 1: Write the failing test**

`plugins/llm-workflow/test/tool.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import { makeWorkflowTool } from "../tool.ts";

function fakeEngine() {
  let lastCall: any = null;
  return {
    engine: {
      list: () => [],
      get: () => undefined,
      register: () => () => {},
      runInline: async (script: string, opts: any) => { lastCall = { kind: "inline", script, opts }; return { runId: "r1", ok: true, value: "v", tokensSpent: 0, agentCount: 0, durationMs: 1 }; },
      runByName: async (name: string, opts: any) => { lastCall = { kind: "name", name, opts }; return { runId: "r1", ok: true, value: name, tokensSpent: 0, agentCount: 0, durationMs: 1 }; },
    },
    lastCall: () => lastCall,
  };
}

describe("Workflow tool handler", () => {
  it("dispatches `script` to runInline", async () => {
    const f = fakeEngine();
    const tool = makeWorkflowTool({ engine: f.engine });
    const ctx = { signal: new AbortController().signal };
    const result = await tool.handler({ script: "export const meta = { name: 'x', description: 'y' };" }, ctx);
    expect(JSON.parse(result).ok).toBe(true);
    expect(f.lastCall().kind).toBe("inline");
  });

  it("dispatches `name` to runByName", async () => {
    const f = fakeEngine();
    const tool = makeWorkflowTool({ engine: f.engine });
    const ctx = { signal: new AbortController().signal };
    const result = await tool.handler({ name: "foo" }, ctx);
    expect(JSON.parse(result).value).toBe("foo");
    expect(f.lastCall().kind).toBe("name");
  });

  it("rejects when neither script/name/scriptPath provided", async () => {
    const f = fakeEngine();
    const tool = makeWorkflowTool({ engine: f.engine });
    const ctx = { signal: new AbortController().signal };
    await expect(tool.handler({}, ctx)).rejects.toThrow(/exactly one of/i);
  });

  it("rejects scriptPath in v1", async () => {
    const f = fakeEngine();
    const tool = makeWorkflowTool({ engine: f.engine });
    const ctx = { signal: new AbortController().signal };
    await expect(tool.handler({ scriptPath: "/tmp/x.ts" }, ctx)).rejects.toThrow(/scriptPath/);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd plugins/llm-workflow && bun test test/tool.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement tool.ts**

`plugins/llm-workflow/tool.ts`:

```typescript
import type { ToolSchema, ToolHandler, ToolExecutionContext } from "llm-contracts/public";
import type { WorkflowRegistryService } from "llm-contracts/public";

const DESCRIPTION = `Run a multi-agent workflow script.

Provide exactly one of:
- \`script\`: inline TypeScript source running in a sandboxed Bun Worker.
- \`name\`: a named workflow registered from ~/.kaizen/workflows or .kaizen/workflows.

Primitives available inside a workflow script (implicit globals):
  agent(prompt, opts?), parallel(thunks), pipeline(items, ...stages),
  phase(title), log(message), workflow(name, args), args, budget.

The script body is evaluated at the top level after \`export const meta = {...}\` is
extracted statically. \`meta\` must be a pure literal (no identifiers, function calls,
spreads, or template interpolation). Determinism guards: Date.now()/Math.random()/
argless new Date() throw inside the sandbox.

Result is a JSON-serialized RunResult ({runId, ok, value?, error?, tokensSpent, agentCount, durationMs}).`;

export interface WorkflowToolDeps {
  engine: Pick<WorkflowRegistryService, "runInline" | "runByName">;
}

export function makeWorkflowTool(deps: WorkflowToolDeps): { schema: ToolSchema; handler: ToolHandler } {
  const schema: ToolSchema = {
    name: "Workflow",
    description: DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        script: { type: "string", description: "Inline workflow source (TS)." },
        name: { type: "string", description: "Run a named workflow from the registry." },
        scriptPath: { type: "string", description: "Reserved for v1.1." },
        args: { description: "Args forwarded to the workflow as the `args` global." },
        title: { type: "string", description: "Ignored (CC parity)." },
        description: { type: "string", description: "Ignored (CC parity)." },
      },
    },
  } as ToolSchema;

  const handler: ToolHandler = async (rawArgs: unknown, _ctx: ToolExecutionContext) => {
    const args = (rawArgs ?? {}) as { script?: string; name?: string; scriptPath?: string; args?: unknown };
    if (args.scriptPath) {
      throw new Error("Workflow tool: `scriptPath` is reserved for v1.1; pass `name` or `script` instead.");
    }
    const provided = ["script", "name"].filter((k) => (args as any)[k] != null);
    if (provided.length !== 1) {
      throw new Error("Workflow tool: provide exactly one of {script, name}.");
    }
    const opts = { args: args.args };
    let result;
    if (args.script != null) result = await deps.engine.runInline(args.script, opts);
    else result = await deps.engine.runByName(args.name!, opts);
    return JSON.stringify(result);
  };

  return { schema, handler };
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `cd plugins/llm-workflow && bun test test/tool.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-workflow/tool.ts plugins/llm-workflow/test/tool.test.ts
git commit -m "llm-workflow: add Workflow tool registration"
```

---

## Task 19: Slash commands

**Files:**
- Create: `plugins/llm-workflow/slash.ts`
- Create: `plugins/llm-workflow/test/slash.test.ts`

- [ ] **Step 1: Write the failing test**

`plugins/llm-workflow/test/slash.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import { makeSlashHandlers } from "../slash.ts";

function fakeEngine(manifests: any[]) {
  return {
    list: () => manifests,
    get: (n: string) => manifests.find((m) => m.meta.name === n),
    register: () => () => {},
    runInline: async () => ({ runId: "r1", ok: true, value: null, tokensSpent: 0, agentCount: 0, durationMs: 1 }),
    runByName: async (n: string, opts: any) => ({ runId: "r1", ok: true, value: `ran:${n}:${JSON.stringify(opts?.args ?? null)}`, tokensSpent: 0, agentCount: 0, durationMs: 1 }),
  };
}

function fakeCmdCtx(args: string) {
  const printed: string[] = [];
  return {
    args,
    printed,
    print: async (s: string) => { printed.push(s); },
  };
}

describe("slash handlers", () => {
  it("/workflows:list — empty", async () => {
    const h = makeSlashHandlers({ engine: fakeEngine([]) });
    const ctx = fakeCmdCtx("");
    await h.listHandler(ctx as any);
    expect(ctx.printed[0]).toMatch(/no workflows/i);
  });

  it("/workflows:list — items", async () => {
    const h = makeSlashHandlers({ engine: fakeEngine([
      { meta: { name: "foo", description: "Desc foo" }, scope: "user", sourcePath: "/u/foo.ts", source: "" },
      { meta: { name: "bar", description: "Desc bar" }, scope: "project", sourcePath: "/p/bar.ts", source: "" },
    ]) });
    const ctx = fakeCmdCtx("");
    await h.listHandler(ctx as any);
    expect(ctx.printed[0]).toContain("foo");
    expect(ctx.printed[0]).toContain("bar");
  });

  it("/workflows:get prints manifest + source", async () => {
    const h = makeSlashHandlers({ engine: fakeEngine([
      { meta: { name: "foo", description: "Desc foo" }, scope: "user", sourcePath: "/u/foo.ts", source: "export const meta = {...}" },
    ]) });
    const ctx = fakeCmdCtx("foo");
    await h.getHandler(ctx as any);
    expect(ctx.printed[0]).toContain("foo");
    expect(ctx.printed[0]).toContain("Desc foo");
    expect(ctx.printed[0]).toContain("/u/foo.ts");
    expect(ctx.printed[0]).toContain("export const meta");
  });

  it("/workflows:run dispatches with parsed JSON args", async () => {
    const h = makeSlashHandlers({ engine: fakeEngine([
      { meta: { name: "demo", description: "d" }, scope: "user", sourcePath: "/u/demo.ts", source: "" },
    ]) });
    const ctx = fakeCmdCtx('demo {"x":1}');
    await h.runHandler(ctx as any);
    const joined = ctx.printed.join("\n");
    expect(joined).toContain(`ran:demo:{"x":1}`);
  });

  it("/workflows:run rejects malformed JSON args", async () => {
    const h = makeSlashHandlers({ engine: fakeEngine([
      { meta: { name: "demo", description: "d" }, scope: "user", sourcePath: "/u/demo.ts", source: "" },
    ]) });
    const ctx = fakeCmdCtx("demo {not-json}");
    await h.runHandler(ctx as any);
    expect(ctx.printed[0]).toMatch(/invalid JSON/i);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd plugins/llm-workflow && bun test test/slash.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement slash.ts**

`plugins/llm-workflow/slash.ts`:

```typescript
import type { SlashCommandHandler, WorkflowRegistryService, WorkflowManifest } from "llm-contracts/public";

export interface SlashDeps {
  engine: WorkflowRegistryService;
}

export function makeSlashHandlers(deps: SlashDeps): {
  listHandler: SlashCommandHandler;
  getHandler: SlashCommandHandler;
  runHandler: SlashCommandHandler;
} {
  const listHandler: SlashCommandHandler = async (cmdCtx) => {
    const items = deps.engine.list();
    if (items.length === 0) {
      await cmdCtx.print("No workflows registered.");
      return;
    }
    const lines = [...items].sort((a, b) => a.meta.name.localeCompare(b.meta.name))
      .map((m) => `- **\`${m.meta.name}\`** [${m.scope ?? "user"}] — ${m.meta.description}`);
    await cmdCtx.print(lines.join("\n"));
  };

  const getHandler: SlashCommandHandler = async (cmdCtx) => {
    const name = cmdCtx.args.trim();
    if (!name) { await cmdCtx.print("Usage: /workflows:get <name>"); return; }
    const m = deps.engine.get(name);
    if (!m) { await cmdCtx.print(`Unknown workflow: ${name}. Run /workflows:list to see registered workflows.`); return; }
    await cmdCtx.print(renderManifest(m));
  };

  const runHandler: SlashCommandHandler = async (cmdCtx) => {
    const raw = cmdCtx.args.trim();
    if (!raw) { await cmdCtx.print("Usage: /workflows:run <name> [json-args]"); return; }
    // Split name and trailing JSON.
    const sp = raw.indexOf(" ");
    const name = sp === -1 ? raw : raw.substring(0, sp);
    const jsonPart = sp === -1 ? "" : raw.substring(sp + 1).trim();
    let parsedArgs: unknown = undefined;
    if (jsonPart) {
      try { parsedArgs = JSON.parse(jsonPart); }
      catch (e) { await cmdCtx.print(`invalid JSON args: ${(e as Error).message}`); return; }
    }
    const result = await deps.engine.runByName(name, { args: parsedArgs });
    await cmdCtx.print(`workflow:run ${name} → ${JSON.stringify(result)}`);
  };

  return { listHandler, getHandler, runHandler };
}

function renderManifest(m: WorkflowManifest): string {
  return [
    `**Workflow**: ${m.meta.name}`,
    `**Scope**: ${m.scope ?? "user"}`,
    `**Source**: ${m.sourcePath ?? "<inline>"}`,
    "",
    `**Description**: ${m.meta.description}`,
    "",
    "**Source:**",
    "```typescript",
    m.source,
    "```",
  ].join("\n");
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `cd plugins/llm-workflow && bun test test/slash.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-workflow/slash.ts plugins/llm-workflow/test/slash.test.ts
git commit -m "llm-workflow: add /workflows:list, get, run slash handlers"
```

---

## Task 20: Status item + prompt section

**Files:**
- Create: `plugins/llm-workflow/status.ts`
- Create: `plugins/llm-workflow/test/status.test.ts`

- [ ] **Step 1: Write the failing test**

`plugins/llm-workflow/test/status.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import { wireStatusItem, buildWorkflowsBlock } from "../status.ts";
import type { WorkflowManifest } from "llm-contracts/public";

describe("status item", () => {
  it("updates status on workflow:start, clears on workflow:end", () => {
    const subs = new Map<string, Array<(p: any) => void>>();
    const on = (n: string, fn: any) => { (subs.get(n) ?? subs.set(n, []).get(n))!.push(fn); };
    const updates: any[] = [];
    const emit = (n: string, p: any) => updates.push({ n, p });
    wireStatusItem({ on, emit });

    (subs.get("workflow:start") ?? []).forEach((fn) => fn({ runId: "r1", name: "demo", phases: [{ title: "Verify" }] }));
    expect(updates.at(-1)).toEqual({ n: "status:item-update", p: { key: "workflow.active", value: expect.stringContaining("demo") } });

    (subs.get("workflow:phase") ?? []).forEach((fn) => fn({ runId: "r1", phase: "Verify" }));
    expect((updates.at(-1)!.p as any).value).toContain("Verify");

    (subs.get("workflow:end") ?? []).forEach((fn) => fn({ runId: "r1", ok: true }));
    expect(updates.at(-1)).toEqual({ n: "status:item-clear", p: { key: "workflow.active" } });
  });

  it("buildWorkflowsBlock returns '' on empty list", () => {
    expect(buildWorkflowsBlock([])).toBe("");
  });

  it("buildWorkflowsBlock renders bullets", () => {
    const ms: WorkflowManifest[] = [
      { meta: { name: "foo", description: "Desc foo" }, source: "", scope: "user" },
      { meta: { name: "runtime:hidden", description: "hidden" }, source: "", scope: "runtime" },
    ];
    const out = buildWorkflowsBlock(ms);
    expect(out).toContain("foo");
    expect(out).not.toContain("runtime:hidden");
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd plugins/llm-workflow && bun test test/status.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement status.ts**

`plugins/llm-workflow/status.ts`:

```typescript
import type { WorkflowManifest } from "llm-contracts/public";

export interface StatusDeps {
  on: (name: string, fn: (p: unknown) => void) => void;
  emit: (name: string, payload: unknown) => void;
}

interface State {
  name: string | null;
  phase: string | null;
  agentDone: number;
  agentTotal: number;
}

export function wireStatusItem(deps: StatusDeps): void {
  const state: State = { name: null, phase: null, agentDone: 0, agentTotal: 0 };

  function flush() {
    if (!state.name) return;
    const phaseStr = state.phase ? `${state.phase}: ${state.agentDone}/${state.agentTotal}` : `${state.agentDone}/${state.agentTotal}`;
    deps.emit("status:item-update", { key: "workflow.active", value: `${state.name} [${phaseStr}]` });
  }

  deps.on("workflow:start", (p) => {
    const { name } = p as { name: string };
    state.name = name; state.phase = null; state.agentDone = 0; state.agentTotal = 0;
    flush();
  });
  deps.on("workflow:phase", (p) => {
    const { phase } = p as { phase: string };
    state.phase = phase;
    flush();
  });
  deps.on("workflow:agent-start", () => {
    state.agentTotal++;
    flush();
  });
  deps.on("workflow:agent-end", () => {
    state.agentDone++;
    flush();
  });
  deps.on("workflow:end", () => {
    state.name = null;
    deps.emit("status:item-clear", { key: "workflow.active" });
  });
}

export function buildWorkflowsBlock(manifests: WorkflowManifest[]): string {
  const visible = manifests.filter((m) => !m.meta.name.startsWith("runtime:"));
  if (visible.length === 0) return "";
  const lines = visible
    .sort((a, b) => a.meta.name.localeCompare(b.meta.name))
    .map((m) => {
      const desc = m.meta.description.length > 200 ? m.meta.description.slice(0, 197) + "..." : m.meta.description;
      return `- \`${m.meta.name}\` — ${desc}`;
    });
  return lines.join("\n");
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `cd plugins/llm-workflow && bun test test/status.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-workflow/status.ts plugins/llm-workflow/test/status.test.ts
git commit -m "llm-workflow: add status item + prompt section builder"
```

---

## Task 21: Plugin lifecycle wiring (`index.ts`)

**Files:**
- Modify: `plugins/llm-workflow/index.ts` (replace skeleton)
- Create: `plugins/llm-workflow/test/index.test.ts` (skeleton lifecycle test)

- [ ] **Step 1: Write the failing test**

`plugins/llm-workflow/test/index.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import plugin from "../index.ts";

describe("plugin manifest", () => {
  it("declares apiVersion 3.0.0, tier unscoped, provides workflow:registry", () => {
    expect(plugin.apiVersion).toBe("3.0.0");
    expect(plugin.permissions?.tier).toBe("unscoped");
    expect(plugin.services?.provides).toContain("workflow:registry");
    expect(plugin.services?.consumes).toContain("events:vocabulary");
    expect(plugin.services?.consumes).toContain("driver:run-conversation");
    expect(plugin.services?.consumes).toContain("tools:registry");
    expect(plugin.services?.consumes).toContain("slash:registry");
  });

  it("setup is idempotent — calling stop after setup completes without throwing", async () => {
    const ctx: any = makeFakeCtx();
    await plugin.setup!(ctx);
    await plugin.stop!();
    // second cycle
    await plugin.setup!(ctx);
    await plugin.stop!();
  });
});

function makeFakeCtx() {
  return {
    log: (_m: string) => {},
    emit: async (_e: string, _p: unknown) => {},
    on: (_e: string, _fn: (p: unknown) => void) => {},
    defineEvent: (_n: string) => {},
    defineService: (_n: string, _meta: any) => {},
    provideService: <T>(_n: string, _impl: T) => {},
    useService: <T>(_n: string): T | undefined => undefined,
    consumeService: (_n: string) => {},
  };
}
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd plugins/llm-workflow && bun test test/index.test.ts`
Expected: FAIL — `useService` returns undefined and setup paths still need wiring.

- [ ] **Step 3: Replace index.ts with the full lifecycle**

`plugins/llm-workflow/index.ts`:

```typescript
import type { KaizenPlugin } from "kaizen/types";
import type {
  WorkflowRegistryService, DriverService, AgentsRegistryService,
  ToolsRegistryService, SlashRegistryService, SystemPromptService,
  ConfigStoreService,
} from "llm-contracts/public";
import type { WorkflowConfigFile } from "./public.d.ts";
import { DEFAULT_CONFIG, CONFIG_SCHEMA } from "./config.ts";
import { makeRegistry, makeRegistryHandle } from "./registry.ts";
import { loadFromDirs } from "./loader.ts";
import { makeRunner } from "./runner.ts";
import { makeEngine } from "./engine.ts";
import { makeWorkflowTool } from "./tool.ts";
import { makeSlashHandlers } from "./slash.ts";
import { wireStatusItem, buildWorkflowsBlock } from "./status.ts";
import { homedir, cpus } from "node:os";
import { readdir, stat as fsStat, realpath as fsRealpath, readFile as fsReadFile } from "node:fs/promises";

let toolUnregister: (() => void) | undefined;
let slashOffs: Array<() => void> = [];
let sectionHandle: { bumpGeneration(): void; unregister(): void } | undefined;

function resolveDir(p: string, home: string, cwd: string): string {
  if (p.startsWith("~/")) return `${home}/${p.slice(2)}`;
  if (p === "~") return home;
  if (p.startsWith("/")) return p;
  return `${cwd}/${p}`;
}

const plugin: KaizenPlugin = {
  name: "llm-workflow",
  apiVersion: "3.0.0",
  permissions: { tier: "unscoped" },
  services: {
    provides: ["workflow:registry"],
    consumes: [
      "events:vocabulary",
      "driver:run-conversation",
      "tools:registry",
      "slash:registry",
      "agents:registry",
      "prompt:registry",
      "config:store",
    ],
  },

  async setup(ctx) {
    ctx.consumeService("events:vocabulary");
    const log = (m: string) => ctx.log(m);

    // Load config.
    let cfg: WorkflowConfigFile = { ...DEFAULT_CONFIG };
    const cfgSvc = ctx.useService<ConfigStoreService>("config:store");
    if (cfgSvc) {
      try {
        cfgSvc.register<WorkflowConfigFile>({
          plugin: "llm-workflow",
          defaults: { ...DEFAULT_CONFIG },
          schema: CONFIG_SCHEMA as any,
        });
        cfg = cfgSvc.get<WorkflowConfigFile>("llm-workflow");
      } catch (e) { log(`llm-workflow: config:store register failed (${(e as Error).message}); using defaults`); }
    } else {
      log("llm-workflow: config:store unavailable; using DEFAULT_CONFIG");
    }

    const home = homedir();
    const cwd = process.cwd();
    const userDir = resolveDir(cfg.userDir, home, cwd);
    const projectDir = resolveDir(cfg.projectDir, home, cwd);

    // Registry: start empty, swap in after discovery.
    const handle = makeRegistryHandle(makeRegistry([]));
    let ready = false;
    ctx.provideService<WorkflowRegistryService>("workflow:registry", {
      list: () => handle.service.list(),
      get: (n) => handle.service.get(n),
      register: (m) => handle.service.register(m),
      runInline: (s, o) => engine.runInline(s, o),
      runByName: (n, o) => engine.runByName(n, o),
    });

    // Status item wiring (events-only — no ui:status dep needed).
    wireStatusItem({ on: ctx.on, emit: (e, p) => { void ctx.emit(e, p); } });

    // Engine + runner.
    const driver = ctx.useService<DriverService>("driver:run-conversation");
    if (!driver) {
      void ctx.emit("harness:error", { message: "llm-workflow: driver:run-conversation unavailable; Workflow tool disabled" });
      return;
    }
    const agentsRegistry = ctx.useService<AgentsRegistryService>("agents:registry");
    const cpuCount = cpus().length;
    const runner = makeRunner({
      driver,
      agentsRegistry,
      emit: (e, p) => { void ctx.emit(e, p); },
      runByName: async (n, opts) => engine.runByName(n, opts),
      timeoutMs: cfg.timeoutMs,
      gracefulShutdownMs: cfg.workerGracefulShutdownMs,
      maxConcurrency: cfg.maxConcurrency ?? (Math.min(16, Math.max(1, cpuCount - 2))),
      maxLifetimeAgents: cfg.maxLifetimeAgents,
      sessionIdProvider: () => `workflow:${Date.now().toString(36)}`, // OK — sessions are host-side, not under sandbox guards
    });
    const engine = makeEngine({ registry: handle, runner, isReady: () => ready });

    // Workflow tool.
    const tools = ctx.useService<ToolsRegistryService>("tools:registry");
    if (tools) {
      const { schema, handler } = makeWorkflowTool({ engine });
      toolUnregister = tools.registerWith({ schema, handler, source: { kind: "local" } });
    } else {
      void ctx.emit("harness:error", { message: "llm-workflow: tools:registry unavailable; Workflow tool not registered" });
    }

    // Slash commands.
    try {
      const slash = ctx.useService<SlashRegistryService>("slash:registry");
      const { listHandler, getHandler, runHandler } = makeSlashHandlers({ engine });
      slashOffs.push(slash.register({ name: "workflows:list", description: "List registered workflows.", source: "plugin" }, listHandler));
      slashOffs.push(slash.register({ name: "workflows:get",  description: "Show one workflow's manifest and source.", usage: "<name>", source: "plugin" }, getHandler));
      slashOffs.push(slash.register({ name: "workflows:run",  description: "Run a named workflow with optional JSON args.", usage: "<name> [json-args]", source: "plugin" }, runHandler));
    } catch { /* slash:registry not defined in this harness — skip */ }

    // Prompt:registry section.
    const promptSystem = ctx.useService<SystemPromptService>("prompt:registry");
    if (promptSystem) {
      sectionHandle = promptSystem.register({
        id: "llm-workflow:available",
        priority: 140,
        title: "Available workflows",
        render: () => buildWorkflowsBlock(handle.service.list()),
      });
    }

    // Discovery in a microtask.
    queueMicrotask(async () => {
      try {
        const result = await loadFromDirs({
          userDir, projectDir,
          maxFileBytes: cfg.metaParse.maxFileBytes,
          deps: {
            readDir: (p) => readdir(p),
            stat: (p) => fsStat(p) as any,
            realpath: (p) => fsRealpath(p),
            readFile: (p) => fsReadFile(p, "utf8"),
          },
        });
        handle.setInner(makeRegistry(result.manifests, () => sectionHandle?.bumpGeneration()));
        ready = true;
        for (const e of result.errors) {
          await ctx.emit("harness:error", { message: `llm-workflow: ${e.path}: ${e.message}` });
        }
        sectionHandle?.bumpGeneration();
      } catch (err) {
        ready = true;
        await ctx.emit("harness:error", { message: `llm-workflow: discovery failed: ${(err as Error).message}` });
      }
    });
  },

  async stop() {
    try { toolUnregister?.(); } catch {} toolUnregister = undefined;
    try { sectionHandle?.unregister(); } catch {} sectionHandle = undefined;
    for (const off of slashOffs) { try { off(); } catch {} }
    slashOffs = [];
  },
};

export default plugin;
```

- [ ] **Step 4: Run, expect PASS**

Run: `cd plugins/llm-workflow && bun test test/index.test.ts`
Expected: PASS.

- [ ] **Step 5: Run full unit suite to verify no regressions**

Run: `cd plugins/llm-workflow && bun test`
Expected: All PASS.

- [ ] **Step 6: Commit**

```bash
git add plugins/llm-workflow/index.ts plugins/llm-workflow/test/index.test.ts
git commit -m "llm-workflow: wire plugin lifecycle (setup + stop)"
```

---

## Task 22: Integration tests (real Bun Worker)

**Files:**
- Create: `plugins/llm-workflow/test/integration/sandbox-e2e.test.ts`
- Create: `plugins/llm-workflow/test/integration/sandbox-guards.test.ts`
- Create: `plugins/llm-workflow/test/integration/sandbox-cancel.test.ts`

- [ ] **Step 1: Write the end-to-end sandbox test**

`plugins/llm-workflow/test/integration/sandbox-e2e.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import { makeRunner } from "../../runner.ts";
import { fakeDriver, eventBus } from "../_helpers.ts";

function mkRunner(args: { driver?: any } = {}) {
  const bus = eventBus();
  const driver = args.driver ?? fakeDriver({
    reply: async (input) => ({ finalMessage: { role: "assistant", content: `reply:${(input.userMessage as any)?.content ?? ""}` }, usage: { promptTokens: 1, completionTokens: 3 } }),
  }).driver;
  const runner = makeRunner({
    driver, agentsRegistry: undefined,
    emit: (e, p) => bus.emit(e, p),
    runByName: async () => { throw new Error("not used"); },
    timeoutMs: 8000, gracefulShutdownMs: 200,
    maxConcurrency: 4, maxLifetimeAgents: 100,
    sessionIdProvider: () => "sess",
  });
  return { runner, bus };
}

describe("sandbox end-to-end", () => {
  it("evaluates a script that calls agent() and returns a value", async () => {
    const { runner, bus } = mkRunner();
    const src = `
      export const meta = { name: "demo", description: "demo" };
      phase("Run");
      log("starting");
      const out = await agent("hello");
      return out;
    `;
    const r = await runner.runInline(src, {});
    expect(r.ok).toBe(true);
    expect(r.value).toBe("reply:hello");
    expect(bus.emitted.find((e) => e.name === "workflow:phase")?.payload).toMatchObject({ phase: "Run" });
    expect(bus.emitted.find((e) => e.name === "workflow:log")?.payload).toMatchObject({ message: "starting" });
    expect(r.agentCount).toBe(1);
  });

  it("parallel() runs two agent calls concurrently", async () => {
    const { runner } = mkRunner();
    const src = `
      export const meta = { name: "demo", description: "demo" };
      const results = await parallel([
        () => agent("a"),
        () => agent("b"),
      ]);
      return results;
    `;
    const r = await runner.runInline(src, {});
    expect(r.ok).toBe(true);
    expect((r.value as string[]).sort()).toEqual(["reply:a", "reply:b"]);
    expect(r.agentCount).toBe(2);
  });

  it("pipeline() chains stages per-item", async () => {
    const { runner } = mkRunner();
    const src = `
      export const meta = { name: "demo", description: "demo" };
      const out = await pipeline([1, 2],
        async (_p, item) => await agent("s1:" + item),
        async (prev) => await agent("s2:" + prev),
      );
      return out;
    `;
    const r = await runner.runInline(src, {});
    expect(r.ok).toBe(true);
    const out = r.value as string[];
    expect(out.length).toBe(2);
    expect(out[0]).toContain("reply:s2:reply:s1:1");
  });

  it("budget accumulates and is hard-capped", async () => {
    const driver = fakeDriver({
      reply: async () => ({ finalMessage: { role: "assistant", content: "x" }, usage: { promptTokens: 1, completionTokens: 50 } }),
    }).driver;
    const { runner } = mkRunner({ driver });
    const src = `
      export const meta = { name: "demo", description: "demo" };
      await agent("a");
      await agent("b");
      return await budget.spent();
    `;
    const r = await runner.runInline(src, { budgetTotal: 1000 });
    expect(r.ok).toBe(true);
    expect(r.value).toBe(100);
  });
});
```

- [ ] **Step 2: Write the guards test**

`plugins/llm-workflow/test/integration/sandbox-guards.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import { makeRunner } from "../../runner.ts";
import { fakeDriver, eventBus } from "../_helpers.ts";

function mkRunner() {
  const bus = eventBus();
  return {
    runner: makeRunner({
      driver: fakeDriver().driver, agentsRegistry: undefined,
      emit: (e, p) => bus.emit(e, p),
      runByName: async () => { throw new Error("not used"); },
      timeoutMs: 4000, gracefulShutdownMs: 200,
      maxConcurrency: 4, maxLifetimeAgents: 100,
      sessionIdProvider: () => "sess",
    }),
    bus,
  };
}

describe("sandbox determinism guards", () => {
  it("Date.now() throws inside the sandbox", async () => {
    const { runner } = mkRunner();
    const src = `
      export const meta = { name: "demo", description: "demo" };
      try { Date.now(); return "no-throw"; }
      catch (e) { return "ok:" + e.message; }
    `;
    const r = await runner.runInline(src, {});
    expect(r.ok).toBe(true);
    expect(String(r.value)).toContain("Date.now()");
  });

  it("Math.random() throws inside the sandbox", async () => {
    const { runner } = mkRunner();
    const src = `
      export const meta = { name: "demo", description: "demo" };
      try { Math.random(); return "no-throw"; }
      catch (e) { return "ok:" + e.message; }
    `;
    const r = await runner.runInline(src, {});
    expect(r.ok).toBe(true);
    expect(String(r.value)).toContain("Math.random()");
  });

  it("argless `new Date()` throws inside the sandbox", async () => {
    const { runner } = mkRunner();
    const src = `
      export const meta = { name: "demo", description: "demo" };
      try { new Date(); return "no-throw"; }
      catch (e) { return "ok:" + e.message; }
    `;
    const r = await runner.runInline(src, {});
    expect(r.ok).toBe(true);
    expect(String(r.value)).toContain("Date()");
  });
});
```

- [ ] **Step 3: Write the cancel test**

`plugins/llm-workflow/test/integration/sandbox-cancel.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import { makeRunner } from "../../runner.ts";
import { fakeDriver, eventBus } from "../_helpers.ts";

describe("sandbox cancellation", () => {
  it("external abort signal terminates the worker", async () => {
    const ac = new AbortController();
    const bus = eventBus();
    const runner = makeRunner({
      driver: fakeDriver({
        reply: async () => { await new Promise((r) => setTimeout(r, 500)); return { finalMessage: { role: "assistant", content: "late" }, usage: { promptTokens: 0, completionTokens: 0 } }; },
      }).driver,
      agentsRegistry: undefined,
      emit: (e, p) => bus.emit(e, p),
      runByName: async () => { throw new Error("not used"); },
      timeoutMs: 5000, gracefulShutdownMs: 200,
      maxConcurrency: 4, maxLifetimeAgents: 100,
      sessionIdProvider: () => "sess",
    });
    setTimeout(() => ac.abort(), 50);
    const r = await runner.runInline(`
      export const meta = { name: "demo", description: "demo" };
      await agent("slow");
      return "done";
    `, { signal: ac.signal });
    expect(r.ok).toBe(false);
    expect(r.error?.name).toBe("WorkflowAbortedError");
  });

  it("timeout terminates the worker", async () => {
    const bus = eventBus();
    const runner = makeRunner({
      driver: fakeDriver({
        reply: async () => { await new Promise((r) => setTimeout(r, 1000)); return { finalMessage: { role: "assistant", content: "late" }, usage: { promptTokens: 0, completionTokens: 0 } }; },
      }).driver,
      agentsRegistry: undefined,
      emit: (e, p) => bus.emit(e, p),
      runByName: async () => { throw new Error("not used"); },
      timeoutMs: 200, gracefulShutdownMs: 50,
      maxConcurrency: 4, maxLifetimeAgents: 100,
      sessionIdProvider: () => "sess",
    });
    const r = await runner.runInline(`
      export const meta = { name: "demo", description: "demo" };
      await agent("slow");
      return "done";
    `, {});
    expect(r.ok).toBe(false);
    expect(r.error?.name).toBe("WorkflowTimeoutError");
  });
});
```

- [ ] **Step 4: Build local then run integration tests**

```bash
cd plugins/llm-workflow && bun build --target=bun --outfile=dist/index.js index.ts
cd plugins/llm-workflow && bun test test/integration
```

Expected: All PASS. (If sandbox-entry path resolution fails, double-check the ENTRY_URL constant in `sandbox-host.ts` and ensure `sandbox-entry.ts` sits next to `dist/`.)

- [ ] **Step 5: Run the entire plugin suite**

Run: `cd plugins/llm-workflow && bun test`
Expected: All PASS.

- [ ] **Step 6: Commit**

```bash
git add plugins/llm-workflow/test/integration/
git commit -m "llm-workflow: integration tests (real Worker sandbox)"
```

---

## Task 23: Marketplace entry + harness manifest

**Files:**
- Modify: `.kaizen/marketplace.json`
- Modify: `harnesses/local.json`
- Run: `kaizen plugin validate plugins/llm-workflow`

- [ ] **Step 1: Inspect harness manifest format**

Run: `cat harnesses/local.json | head -60`
Expected: JSON with a top-level `plugins` array. Each entry has `{ name, version }` or similar — match the existing shape.

- [ ] **Step 2: Add the new marketplace entries**

Edit `.kaizen/marketplace.json`. In the `entries` array, **prepend new versions** for `llm-contracts` (0.6.0) and `llm-events` (0.8.0):

```jsonc
// In the `llm-contracts` entry, prepend to versions[]:
{ "version": "0.6.0", "source": { "type": "file", "path": "plugins/llm-contracts" } },

// In the `llm-events` entry, prepend to versions[]:
{ "version": "0.8.0", "source": { "type": "file", "path": "plugins/llm-events" } },
```

Then add a new top-level entry for `llm-workflow` (place after `llm-tui` or in conversation cluster — match the existing grouping):

```jsonc
{
  "kind": "plugin",
  "name": "llm-workflow",
  "description": "Sandboxed multi-agent workflow orchestration. Provides workflow:registry and the Workflow tool.",
  "categories": ["workflow", "agents", "llm"],
  "versions": [
    { "version": "0.1.0", "source": { "type": "file", "path": "plugins/llm-workflow" } }
  ]
}
```

- [ ] **Step 3: Add the plugin to the local harness**

Edit `harnesses/local.json`. Add `llm-workflow@0.1.0` to the plugin list, *after* `llm-agents` (so topo order satisfies the topo-hint deps). Bump `llm-contracts` and `llm-events` pins to the new versions.

Concretely: locate the `plugins` array and add an entry matching the existing format (e.g. `{ "name": "llm-workflow", "version": "0.1.0" }`) after `llm-agents`. Update the `llm-contracts` and `llm-events` entries to point at `0.6.0` and `0.8.0`.

- [ ] **Step 4: Run plugin validate**

Run: `kaizen plugin validate plugins/llm-workflow`
Expected: PASS (no errors). If the validator complains about missing `dist/index.js`, run the build first:

```bash
cd plugins/llm-workflow && bun build --target=bun --outfile=dist/index.js index.ts
```

- [ ] **Step 5: Build everything cleanly**

```bash
bun install
bun test
```

Expected: All workspace tests pass.

- [ ] **Step 6: Smoke-test the harness boot path**

Per the spec ("acid test"): boot the local harness from the checkout. If you have a configured `openai-llm` endpoint, run:

```bash
kaizen --harness ./harnesses/local.json
```

If not configured, at least confirm `kaizen --harness ./harnesses/local.json --dry-run` (if available) or read the boot logs to confirm `llm-workflow` setup succeeded with no `harness:error`. If your kaizen version lacks `--dry-run`, skip this step and rely on integration tests + `bun test`.

- [ ] **Step 7: Commit**

```bash
git add .kaizen/marketplace.json harnesses/local.json plugins/llm-workflow/dist/
git commit -m "marketplace: add llm-workflow@0.1.0; bump llm-contracts→0.6.0, llm-events→0.8.0"
```

---

## Done

The plan is complete. Confirm by running the entire workspace test suite once more:

```bash
bun test
```

All tests should pass. The plugin is ready to be deployed locally via the snippet in `plugins/llm-workflow/CLAUDE.md`.

---

## Self-review notes

(Filled in inline after writing the plan above.)

**Spec coverage:**
- Plugin layout (§Plugin layout): Tasks 3, 4, 5, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21.
- Contract surface (§Contract surface): Task 1.
- Event vocab (§Event vocab): Task 2.
- Service dependencies (§Service dependencies): Task 21 (`index.ts`).
- Sandbox & RPC (§Sandbox & RPC): Tasks 11 (rpc-types), 12 (sandbox-entry), 13 (sandbox-host), 22 (integration).
- Workflow tool (§4a): Task 18.
- Slash commands (§4b): Task 19.
- On-disk registry (§4c): Tasks 9 (registry), 10 (loader), 21 (wiring).
- Prompt section (§4d): Task 20 (`buildWorkflowsBlock`) + Task 21 (`promptSystem.register`).
- Status item (§4e): Task 20.
- Concurrency (§5 Cross-cutting): Tasks 7 (semaphore), 14 (acquire/release in agent), 16 (runner sets cap).
- Budget (§5): Tasks 8, 14, 16.
- Cancellation (§5): Tasks 13 (sandbox-host abort wiring), 22 (cancel integration test).
- Error taxonomy (§5): Task 4.
- Configuration (§5): Task 5; consumed in Task 21.
- Permissions tier (§5): Task 21 (`permissions: { tier: "unscoped" }`).
- Testing (§Testing): Tasks 4–22 (unit + integration). Worktree/resume deferred per spec.
- Marketplace + harness manifest: Task 23.

**Placeholder scan:** No "TBD"/"TODO"/"implement later" markers. Code blocks are complete and runnable.

**Type consistency:**
- `WorkflowMeta` / `WorkflowManifest` / `RunResult` / `RunOptions` all sourced from `llm-contracts/public` and matching usage across tasks.
- `WorkflowPhase` defined in Task 1 (`contracts/workflow-registry.ts`), consumed in Task 11 (`rpc-types.ts:BootMsg.metaPhases: WorkflowPhase[]`) and Task 16 (runner emits `meta.phases ?? []`).
- `AgentCallPayload` defined in Task 11, consumed in Task 14 (agent primitive) and Task 12 (sandbox entry RPC).
- `Semaphore`/`Budget`/`RegistryHandle`/`Runner` types stable across tasks.
- `agent()` ambient signature: returns `Promise<string | null>` (Task 3 ambient) — matches host-side `makeAgentCallback` return (Task 14) and the worker-side global wired in `installPrimitives` (Task 12).
- One known potential drift: `agent()` returns `null` only via `parallel`/`pipeline` swallowing errors (Task 12); the direct `agent()` call rejects on error — match the CC contract documented in the ambient. The plan keeps this consistent.
