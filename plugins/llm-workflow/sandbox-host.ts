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
