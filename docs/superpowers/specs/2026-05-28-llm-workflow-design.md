# llm-workflow — Design

Date: 2026-05-28
Status: Draft, brainstormed
Author: chancock

## Goal

Add a kaizen-native deterministic multi-agent orchestration capability to the local harness, in the spirit of Claude Code's `Workflow` tool. A workflow is a JavaScript/TypeScript script that orchestrates subagent calls (`agent`, `parallel`, `pipeline`, `phase`, `log`, nested `workflow`, structured-output schemas, budget accounting) and is executed in a per-run Bun Worker sandbox. The LLM can author scripts inline, the user can call named workflows by name, and either can fire workflows on disk.

A future Claude Code compatibility shim is anticipated, but this design is **kaizen-native first**: the architecture leans on existing kaizen contracts and conventions, and the CC-style scripts ride on top.

## Non-goals

- Bug-for-bug parity with Claude Code's internal implementation (sandbox choice, journal format, progress-tree renderer).
- v1 worktree isolation (`agent({isolation: "worktree"})`) — deferred to v1.1.
- v1 resume from `runId` — deferred to v1.1; journal hook points stubbed.

## Locked decisions (from brainstorming)

| # | Decision |
|---|---|
| 1 | Trust model: **sandboxed inline** (option B). Workflows owns its own Bun Worker sandbox — no dependency on `llm-codemode`. The two sandboxes coexist because Bun Workers have no shared mutable globals; only stdout-claiming TUI libs like Ink conflict at the process level. |
| 2 | Subagent backing: **`driver:run-conversation` direct**. Bypass the `dispatch_agent` tool. `agentType` opt is an optional overlay from `agents:registry`. |
| 3 | Invocation surface: **Workflow tool + slash commands + on-disk registry, all in v1**. Slash commands: `/workflows:run`, `/workflows:list`, `/workflows:get`. |
| 4 | v1 API scope: **Core + Rich tiers**. Worktrees and resume deferred. |
| 5 | Observability: **status item + chat event log**. New `workflow:*` events in the shared VOCAB; a fancy dedicated UI can be a future additive plugin. |
| 6 | Storage: `~/.kaizen/workflows/*.ts` (user) and `<cwd>/.kaizen/workflows/*.ts` (project, shadows user). |
| 7 | Script shape: **match CC exactly** — top-level statements, `export const meta = {...}` as a pure literal, primitives as implicit globals. Worth the model-authoring ergonomics and the near-zero compatibility shim. |
| 8 | Plugin granularity: **single plugin `llm-workflow`** (matches the repo convention of llm-agents and llm-codemode). Extensibility comes from the contract and event surfaces, not from plugin splitting. |

## Plugin layout

New plugin: **`plugins/llm-workflow/`**.

```
plugins/llm-workflow/
├── index.ts              # setup(): registers tool, slash cmds, status item; wires services
├── package.json
├── public.d.ts           # implementation-internal types (errors, config shape)
├── README.md
├── CLAUDE.md             # invariants + module map (per repo convention)
├── config.ts             # config schema + defaults (registered with config:store)
├── engine.ts             # public engine class: runInline, runByName, list, get
├── runner.ts             # one workflow run: orchestrates Worker, semaphore, journal hooks
├── sandbox-host.ts       # spawns Bun Worker, RPC dispatch from Worker → host primitives
├── sandbox-entry.ts      # Worker-side entry: installs globals, evals script, talks back via RPC
├── rpc-types.ts          # shared RPC message types (host ↔ worker)
├── primitives/
│   ├── agent.ts          # agent() impl: driver call + agents:registry overlay + budget
│   ├── parallel.ts       # parallel() barrier + semaphore acquire
│   ├── pipeline.ts       # pipeline() no-barrier per-item chains
│   ├── phase.ts          # phase()/log() — emit events
│   └── workflow.ts       # nested workflow() — sub-engine call (shares RunContext)
├── budget.ts             # token accounting from llm:done events (response.usage.completionTokens)
├── semaphore.ts          # shared concurrency cap (min(16, cpu-2)), lifetime cap (1000)
├── registry.ts           # named-workflow registry + programmatic register()
├── loader.ts             # file discovery from user + project dirs (microtask, like llm-agents)
├── meta-parse.ts         # static AST extraction of `export const meta` (no eval)
├── tool.ts               # Workflow tool registration (handler delegates to engine)
├── slash.ts              # /workflows:run, /workflows:list, /workflows:get
├── status.ts             # status:item-update emitter for running workflows
├── ambient.d.ts          # shipped alongside: declares agent/parallel/etc as globals
├── dist/
├── test/
└── tsconfig.json
```

Two notes on shape:

- `engine.ts` is the only exported surface bound to `workflow:registry`. Everything else is internal.
- `meta-parse.ts` does AST-level extraction of the `meta` literal before sandboxing — the script is never executed for its `meta`, which lets `meta` be trusted ahead of running untrusted code.

## Contract surface (new in `llm-contracts`)

File: **`plugins/llm-contracts/contracts/workflow-registry.ts`**.

```ts
export interface WorkflowMeta {
  name: string;
  description: string;
  whenToUse?: string;
  phases?: Array<{ title: string; detail?: string; model?: string }>;
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
  list(): WorkflowManifest[];                                       // public view, no inline
  get(name: string): WorkflowManifest | undefined;
  register(manifest: WorkflowManifest): () => void;                 // name MUST start with "runtime:"
  runInline(script: string, opts?: RunOptions): Promise<RunResult>;
  runByName(name: string, opts?: RunOptions): Promise<RunResult>;
}
```

- Contract ID: **`workflow:registry`** (matches `<domain>:<role>`).
- Exported from `plugins/llm-contracts/public.ts`.
- Defined (once) in `llm-contracts/index.ts` via `defineService("workflow:registry", ...)`.

## Event vocab (new in `llm-events` VOCAB)

Added to the frozen `VOCAB` object in `llm-events` and the `Vocab` type in `llm-contracts/contracts/events.ts`:

| Event | Payload |
|---|---|
| `workflow:start` | `{ runId, name, phases: WorkflowMeta["phases"], inline: boolean }` (full phase entries from meta, including `model` if present) |
| `workflow:phase` | `{ runId, phase }` |
| `workflow:agent-start` | `{ runId, agentId, label, phase?, model?, prompt: string }` |
| `workflow:agent-end` | `{ runId, agentId, ok: boolean, tokensSpent: number, error?: { name, message } }` |
| `workflow:log` | `{ runId, message }` |
| `workflow:end` | `{ runId, ok: boolean, value?, error?, tokensSpent, agentCount, durationMs }` |

Subscribers consume via `ctx.on(eventName, handler)` (same pattern as `llm-agents`/`llm-tool-approval`):
- Status item (`status.ts`) — running-workflow badge.
- Chat-log printer — surfaces `phase`, `log`, `agent-start`/`agent-end` into the user's scrollback.
- Future fancy progress-tree plugin — same event stream, additive.

## Service dependencies

`llm-workflow`'s `services.consumes`:

| Service | Dep type | Why |
|---|---|---|
| `events:vocabulary` | hard | emit/subscribe lifecycle events |
| `driver:run-conversation` | hard | back `agent()` calls |
| `tools:registry` | hard | register the `Workflow` tool |
| `slash:registry` | hard | register `/workflows:*` commands |
| `agents:registry` | topo-hint optional | `agentType` lookup; degrade to anonymous if absent |
| `prompt:registry` | topo-hint optional | inject `Available workflows` section into system prompt |
| `config:store` | topo-hint optional | configurable maxConcurrency, maxLifetimeAgents, dirs, timeoutMs |
| `ui:status` | deferred optional | status-item updates if a TUI is loaded |

The plugin subscribes to `llm:done` for budget accounting; payload `{ response, turnId, sessionId, latencyMs }` where `response.usage?.completionTokens` is the output-token count to accumulate.

## Sandbox & RPC

### Process model

```
┌─────────────────────────────────────────────────────────────────┐
│ Harness process (Bun)                                            │
│                                                                  │
│  llm-workflow plugin                                             │
│    engine.runInline(script, opts)                                │
│      │                                                           │
│      ├── meta-parse: static AST → WorkflowMeta (or throw)        │
│      ├── runner: new RunContext { runId, semaphore, budget, ... }│
│      ├── emit workflow:start                                     │
│      ├── sandbox-host: spawn Worker, postMessage(BOOT)           │
│      │                                                           │
│      │   ┌──────────────────────────────────────────────────┐   │
│      │   │ Worker (sandbox-entry)                            │   │
│      │   │                                                   │   │
│      │   │   on BOOT:                                        │   │
│      │   │     install globals: agent, parallel, pipeline,   │   │
│      │   │       phase, log, workflow, args, budget          │   │
│      │   │     await (async () => { <script source> })()     │   │
│      │   │     postMessage(DONE, returnValue)                │   │
│      │   │                                                   │   │
│      │   │   each primitive call →                           │   │
│      │   │     postMessage(CALL, {kind, args, callId})       │   │
│      │   │     await reply (CALL_RESULT or CALL_ERROR)       │   │
│      │   └──────────────────────────────────────────────────┘   │
│      │                                                           │
│      ├── on CALL: route to primitives/*.ts, await result,        │
│      │     postMessage(CALL_RESULT | CALL_ERROR, {callId, ...}) │
│      ├── on DONE / WORKER_ERROR / timeout: cleanup, emit         │
│      │     workflow:end                                          │
│      └── return RunResult                                        │
└─────────────────────────────────────────────────────────────────┘
```

### RPC types (`rpc-types.ts`)

```ts
// host → worker
type Boot = { t: "BOOT"; runId: string; source: string; args: unknown; metaPhases: WorkflowPhase[] };
type CallResult = { t: "CALL_RESULT"; callId: number; value: unknown };
type CallError = { t: "CALL_ERROR"; callId: number; error: { name: string; message: string; stack?: string } };
type Cancel = { t: "CANCEL"; reason: string };

// worker → host
type Ready = { t: "READY" };
type Call = { t: "CALL"; callId: number; kind: "agent" | "log" | "phase" | "workflow" | "budgetRead"; payload: unknown };
type Done = { t: "DONE"; value: unknown };
type WorkerError = { t: "WORKER_ERROR"; error: { name: string; message: string; stack?: string } };
```

### Two design points

**1. `parallel()` and `pipeline()` run worker-side, not host-side.**
Both helpers are pure JS installed as globals. Each thunk they invoke calls `agent()`, which RPCs to the host as a separate `CALL`. The *host* has the semaphore; the worker is stateless except for in-flight call IDs. This avoids a second concurrency layer.

**2. Budget reads are async RPC under a sync-looking facade.**
Workflows write `budget.remaining()` like a synchronous call. Implementation returns a `Promise<number>`; most scripts `await` it (idiomatic given the `while`-loop usage shown in CC docs). Documented in `ambient.d.ts`. The host accumulates tokens from `llm:done` events and replies to each `budgetRead` RPC with the current totals.

### Sandbox guarantees

| Guarantee | Mechanism |
|---|---|
| Timeout | RunContext starts `setTimeout(abort, timeoutMs)` on construction; abort posts `CANCEL` then `worker.terminate()` after a 1s grace. |
| No filesystem / no Node APIs | Bare imports outside an allowlist (currently empty) are blocked via a module-resolution shim in `sandbox-entry`. Workflows are pure orchestration. |
| Determinism guards | `Date.now()`, `Math.random()`, argless `new Date()` throw inside the worker — preserves resume determinism for v1.1. Installed in `sandbox-entry` as shims. |
| Globals tamper-proof | Primitives installed via `Object.defineProperty(globalThis, ..., { writable: false, configurable: false })`. |

### Failure mapping

| Failure | Behavior |
|---|---|
| Static parse of `meta` fails | engine throws before spawning worker; `RunResult.ok=false`, error name `MetaParseError` |
| Worker fails to load | `WorkerSpawnError`, no `workflow:start` emitted |
| Script throws | worker posts `WORKER_ERROR`, host emits `workflow:end {ok:false}`, returns error in `RunResult` |
| `agent()` throws inside parallel/pipeline | host returns `CALL_ERROR`, script-side helper resolves to `null` (matches CC semantics) — caller `.filter(Boolean)` |
| Timeout | `WorkflowTimeoutError`, worker terminated |
| Abort signal | `WorkflowAbortedError`, worker terminated |
| Lifetime cap exceeded (1000 agents) | next `agent()` RPC returns `CALL_ERROR` with `AgentLifetimeCapError` |
| Nesting depth > 1 | `WorkflowNestingError` from `workflow()` primitive |

## Public surfaces

### Workflow tool

Registered with `tools:registry` as `Workflow`, tags `["workflow", "core"]`.

```ts
{
  name: "Workflow",
  description: "Run a multi-agent workflow script. ...",
  parameters: {
    type: "object",
    properties: {
      script:      { type: "string",  description: "Inline workflow source (TS). Mutually exclusive with name/scriptPath." },
      name:        { type: "string",  description: "Run a named workflow from the registry." },
      scriptPath:  { type: "string",  description: "Run a workflow from a path (file:// or workspace-relative)." },
      args:        {},
      title:       { type: "string" },     // ignored, CC parity
      description: { type: "string" }      // ignored, CC parity
    },
    oneOf: [
      { required: ["script"] }, { required: ["name"] }, { required: ["scriptPath"] }
    ]
  }
}
```

Handler delegates to `engine.runInline` / `engine.runByName`. Tool result is the serialized `RunResult` (truncated at the standard tool-output cap).

The tool description is the load-bearing teaching surface for the LLM — it explains primitives, the `meta` block, and patterns (pipeline-by-default, adversarial verify, loop-until-dry). Mostly cribbed from CC's published tool description with kaizen-specific edits.

### Slash commands

All registered with `slash:registry`:

| Command | Args | Behavior |
|---|---|---|
| `/workflows:list` | — | One line per registered workflow: `name — description`. Reads `engine.list()`. |
| `/workflows:get <name>` | name | Print manifest header (meta block, scope, sourcePath) followed by full source. |
| `/workflows:run <name> [json-args]` | name + optional JSON args | Call `engine.runByName(name, {args: parsed})`. Stream lifecycle events to chat (via `ui:channel`). Final line is the `RunResult` summary. |

### On-disk registry

Discovery at setup, identical pattern to `llm-agents`:

- **User scope:** `~/.kaizen/workflows/*.ts`
- **Project scope:** `<cwd>/.kaizen/workflows/*.ts` (project shadows user on name collision)
- File size cap: **64 KiB** (mirrors llm-agents). Larger → skip + `harness:error`.
- Symlink cycle protection: same as llm-agents.
- Discovery in a microtask; during load, `runByName` returns `WorkflowRegistryLoadingError`.
- One-shot at setup. No reload in v1.

Per file:
1. Read source.
2. `meta-parse.extract(source)` — AST walk to pluck `export const meta = {...}`. Reject if not a pure literal.
3. Validate `meta.name === path.basename(file, ".ts")`. Reject mismatch.
4. Register a `WorkflowManifest` in the in-memory registry.

Programmatic `register(manifest)` requires `manifest.meta.name` to start with `runtime:` (matches llm-agents convention).

### System prompt section (when `prompt:registry` is present)

Register `Available workflows` (id `llm-workflow:available`, priority `140`). One bullet per non-`runtime:` workflow, name + description trimmed to ~200 chars. Empty → renderer returns `""` and section drops.

### Status item (when `ui:status` is present)

Subscribe to `workflow:*` events; maintain `{ key: "workflow.active", value: "<name> [<phase>: <done>/<total>]" }`. Cleared on `workflow:end`.

## Cross-cutting

### Concurrency

- One semaphore per `RunContext`. Default cap: `min(16, max(1, cpuCount - 2))`.
- Nested `workflow(name, args)` shares the parent's RunContext (semaphore, budget, abort, lifetime counter).
- Nesting depth cap: **1**. Deeper → `WorkflowNestingError`.
- Lifetime cap: **1000 agent calls** per RunContext. Hard backstop; exceeded → `AgentLifetimeCapError` returned to subsequent `CALL`s.

### Budget

- Exposed worker-side as `{ total: number | null, spent(): Promise<number>, remaining(): Promise<number> }`.
- `total` set per-run from `RunOptions.args.budget` or `null` if unset.
- Host-side `budget.ts` subscribes to the `llm:done` event (payload: `{ response: LLMResponse, turnId, sessionId, latencyMs }`); accumulates `response.usage?.completionTokens` per turn.
- Hard ceiling: `spent >= total` → next `agent()` returns `CALL_ERROR` with `BudgetExceededError`.

### Cancellation

Three paths, one mechanism (`RunContext.AbortController`):

1. **External abort** — caller's `RunOptions.signal` wired as downstream.
2. **Timeout** — `setTimeout(abort, timeoutMs)` on construction, cleared on natural completion.
3. **Parent turn abort** — tool-execution context's abort signal chained in.

Abort fires → host posts `CANCEL` to worker (1s grace), then `worker.terminate()`. In-flight `agent()` calls abort their downstream `driver:run-conversation` signal.

### Error taxonomy

Concrete classes in `llm-workflow/public.d.ts` (and `.ts`):

| Error | When |
|---|---|
| `MetaParseError` | static AST walk fails or `meta` isn't a pure literal |
| `WorkerSpawnError` | Worker fails to start |
| `ScriptError` | script body threw |
| `WorkflowTimeoutError` | timeout exceeded |
| `WorkflowAbortedError` | external abort |
| `WorkflowNestingError` | depth > 1 |
| `AgentLifetimeCapError` | > 1000 agent calls |
| `BudgetExceededError` | spent >= total |
| `WorkflowRegistryLoadingError` | runByName during initial scan |
| `WorkflowNotFoundError` | runByName for unknown name |

Per the contract-vs-impl rule, error classes stay in the plugin, not in `llm-contracts`. Consumers `catch (e)` by `e.name` if needed.

### Configuration

Routed through `config:store` under section key `llm-workflow`. Defaults:

```jsonc
{
  "plugins": {
    "llm-workflow": {
      "userDir": "~/.kaizen/workflows",
      "projectDir": ".kaizen/workflows",
      "maxConcurrency": null,        // null → auto: min(16, cpu-2)
      "maxLifetimeAgents": 1000,
      "timeoutMs": 600000,
      "workerGracefulShutdownMs": 1000,
      "metaParse": {
        "maxFileBytes": 65536
      }
    }
  }
}
```

If `config:store` is absent, defaults apply and the plugin still boots.

### Permissions tier

`tier: unscoped`. Same as `llm-agents` — the plugin recursively invokes the driver. Treat as trusted infrastructure.

## Testing

Per-plugin: `plugins/llm-workflow/test/`. Run with `cd plugins/llm-workflow && bun test`.

### Unit tests (no harness, no Worker)

| File | Covers |
|---|---|
| `test/meta-parse.test.ts` | AST extraction: valid literal, computed value (rejected), missing `name`/`description` (rejected), template interpolation (rejected), spread (rejected), filename-mismatch (rejected) |
| `test/semaphore.test.ts` | Concurrency gate: respects cap, releases on resolve and reject, lifetime counter, fail-fast after cap |
| `test/budget.test.ts` | Token accounting: starts at 0, accumulates from mocked `llm:done` events, `remaining()` math, hard ceiling triggers `BudgetExceededError` |
| `test/registry.test.ts` | In-memory registry: add/remove, `runtime:` name guard, name collision rejection, `list()` returns public view only |
| `test/loader.test.ts` | File discovery: user vs project precedence, size cap, symlink cycle, malformed `meta`, microtask boot timing |
| `test/primitives/agent.test.ts` | `agent()` host-side: driver call args, `agentType` overlay from `agents:registry`, returns final assistant text, abort propagation, lifecycle events |
| `test/primitives/parallel.test.ts` | Barrier semantics: all resolve, error → `null`, concurrency capped |
| `test/primitives/pipeline.test.ts` | Per-item independence: item B in stage 3 while A still in stage 1; stage throw drops to `null`, skips remaining stages |
| `test/primitives/workflow.test.ts` | Nested workflow: shares RunContext; depth > 1 throws |

### Integration tests (real Worker)

| File | Covers |
|---|---|
| `test/integration/engine-run-inline.test.ts` | end-to-end: inline script using `agent`/`parallel`/`phase`/`log` returns expected `RunResult`, fires expected event sequence |
| `test/integration/engine-run-by-name.test.ts` | named workflow loaded from a tmpdir, run via `runByName` |
| `test/integration/sandbox-deterministic-guards.test.ts` | `Date.now()`, `Math.random()`, argless `new Date()` throw inside the worker |
| `test/integration/sandbox-timeout.test.ts` | infinite loop triggers timeout, worker terminated, `WorkflowTimeoutError` |
| `test/integration/sandbox-cancel.test.ts` | abort signal propagates, in-flight `agent()` torn down |
| `test/integration/tool-handler.test.ts` | Workflow tool registration; `script` / `name` / `scriptPath` dispatch paths |
| `test/integration/slash-run.test.ts` | `/workflows:run foo {"x":1}` parses args, fires the engine, prints lifecycle events |
| `test/integration/events-vocab.test.ts` | All six `workflow:*` events fire with expected payload shapes |

### Contract test

`test/contract.test.ts` — stub-provider acid test from `docs/PLUGIN_ARCHITECTURE.md`: a fake plugin providing `workflow:registry` types from `llm-contracts/public` lets the harness boot; slash commands and Workflow tool still register and degrade cleanly.

### CI gate

`kaizen plugin validate plugins/llm-workflow` runs after manifest/permissions/`public.d.ts` changes.

### Out of scope for v1 tests

- Worktree isolation (deferred to v1.1).
- Resume (deferred to v1.1) — journal hook points stubbed in `runner.ts`.
- Real LLM round-trips — all `driver:run-conversation` calls mocked.

## Future work (post-v1)

- **Worktree isolation** (`agent({isolation: "worktree"})`): add a worktree provisioner that creates a per-agent git worktree, cleans up if unchanged, returns path+branch otherwise.
- **Resume** (`resumeFromRunId`): persist a journal of `agent()` calls keyed by `(prompt, opts)` hash; on resume, longest unchanged prefix returns cached results, first edited call and everything after runs live. Determinism guards already in place from v1.
- **Claude Code compatibility shim**: a tiny adapter so CC's `Workflow({script, name, scriptPath})` tool-call shape passes through unchanged. Should be near-zero given v1 already matches CC's script shape.
- **Dedicated progress UI plugin**: subscribes to the existing `workflow:*` events and renders the tree à la CC's `/workflows` view. Additive — no engine changes required.
- **Programmatic workflow registration** by other plugins via `runtime:` names is supported in v1; future plugins can ship workflows that way.

## References

- `docs/PLUGIN_ARCHITECTURE.md` — contract ownership, contract-id naming, dep-type taxonomy, swappability acid test.
- `plugins/llm-agents/README.md` — registry+loader+tool pattern reused for shape.
- `plugins/llm-codemode/README.md` — Bun Worker sandbox pattern reused conceptually (separate implementation).
- `plugins/llm-contracts/README.md` — recipe for adding a contract.
- `plugins/llm-events/` — VOCAB and event subscription pattern.
