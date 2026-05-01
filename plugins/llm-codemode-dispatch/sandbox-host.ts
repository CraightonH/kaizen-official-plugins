import type { ToolsRegistryService } from "llm-events/public";
import type { CodeModeConfig } from "./config.ts";
import type { HostToWorker, WorkerToHost, InitMsg, ToolResultMsg } from "./rpc-types.ts";
import { wrapCode } from "./wrapper.ts";
import { truncate } from "./serialize.ts";

export type SandboxRunResult =
  | { ok: true; returnValue: unknown; stdout: string }
  | { ok: false; errorName: string; errorMessage: string; stdout: string };

const ENTRY_URL = new URL("./sandbox-entry.ts", import.meta.url).href;

export async function runInSandbox(
  userCode: string,
  registry: ToolsRegistryService,
  signal: AbortSignal,
  config: CodeModeConfig,
  emit?: (event: string, payload: unknown) => Promise<void>,
  turnId?: string,
): Promise<SandboxRunResult> {
  const wrap = wrapCode(userCode);
  if (wrap.transpileError) {
    return { ok: false, errorName: "SyntaxError", errorMessage: wrap.transpileError, stdout: "" };
  }

  const worker = new (globalThis as any).Worker(ENTRY_URL, { type: "module" });
  let stdout = "";
  let stdoutBytes = 0;
  let settled = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const inflightToolControllers = new Set<AbortController>();

  const cleanup = () => {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    try { worker.terminate(); } catch {}
    for (const ac of inflightToolControllers) { try { ac.abort(); } catch {} }
    inflightToolControllers.clear();
  };

  return new Promise<SandboxRunResult>((resolve, reject) => {
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      const err = new Error("aborted");
      (err as any).name = "AbortError";
      reject(err);
    };
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener("abort", onAbort, { once: true });

    timeoutHandle = setTimeout(() => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      cleanup();
      resolve({ ok: false, errorName: "TimeoutError", errorMessage: `code did not complete within ${config.timeoutMs}ms`, stdout });
    }, config.timeoutMs);

    worker.onmessage = async (ev: MessageEvent<WorkerToHost>) => {
      const msg = ev.data;
      if (msg.type === "stdout") {
        if (stdoutBytes >= config.maxStdoutBytes) return;
        const remaining = config.maxStdoutBytes - stdoutBytes;
        const slice = Buffer.byteLength(msg.chunk, "utf8") <= remaining ? msg.chunk : msg.chunk.slice(0, remaining);
        stdout += slice;
        stdoutBytes += Buffer.byteLength(slice, "utf8");
        return;
      }
      if (msg.type === "tool-invoke") {
        const ac = new AbortController();
        inflightToolControllers.add(ac);
        try {
          const value = await registry.invoke(msg.name, msg.args, {
            signal: ac.signal,
            callId: msg.id,
            turnId,
            log: (m) => { void emit?.("status:item-update", { key: `tool:${msg.id}`, value: m }); },
          });
          worker.postMessage({ type: "tool-result", id: msg.id, ok: true, value } satisfies ToolResultMsg);
        } catch (err) {
          worker.postMessage({
            type: "tool-result",
            id: msg.id,
            ok: false,
            error: { name: (err as Error)?.name ?? "Error", message: String((err as Error)?.message ?? err) },
          } satisfies ToolResultMsg);
        } finally {
          inflightToolControllers.delete(ac);
        }
        return;
      }
      if (msg.type === "done") {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        cleanup();
        resolve({ ok: true, returnValue: msg.returnValue, stdout: truncate(stdout, config.maxStdoutBytes) });
        return;
      }
      if (msg.type === "error") {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        cleanup();
        resolve({ ok: false, errorName: msg.name, errorMessage: msg.message, stdout: truncate(stdout, config.maxStdoutBytes) });
        return;
      }
    };

    worker.onerror = (e: ErrorEvent) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      cleanup();
      resolve({ ok: false, errorName: "WorkerCrash", errorMessage: e?.message ?? "worker crashed", stdout });
    };

    const init: InitMsg = { type: "init", wrappedCode: wrap.wrapped, maxStdoutBytes: config.maxStdoutBytes };
    worker.postMessage(init satisfies HostToWorker);
  });
}
