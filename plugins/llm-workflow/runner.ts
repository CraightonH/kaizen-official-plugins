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
import { counter } from "./util-counter.ts";

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
