import type { ToolsRegistryService as EventsRegistry } from "llm-events/public";
import type { ToolsRegistryService as FullRegistry, ToolRegistration } from "llm-tools-registry/public";

// The host needs both `invoke` (events surface) and `listRegistrations`
// (full registry surface) so the worker can build a grouped kaizen global.
type SandboxRegistry = EventsRegistry & Pick<FullRegistry, "listRegistrations">;
import type { CodeModeConfig } from "./config.ts";
import type { HostToWorker, WorkerToHost, InitMsg, ToolResultMsg, RegistrationMeta } from "./rpc-types.ts";
import { wrapCode } from "./wrapper.ts";
import { truncate } from "./serialize.ts";
import { normalizeServerName } from "./assembler.ts";

/**
 * Build the `kaizen` global object exposed inside the sandbox.
 *
 * Tools are grouped by source:
 *   - local  → kaizen.tools.<name>
 *   - mcp    → kaizen.mcp.<normalizedServer>.<name>
 *   - agent  → kaizen.agents.<name>
 *   - skill  → kaizen.skills.<name>
 *   - memory → kaizen.memory.<name>
 *
 * Empty groups are omitted so the surface only advertises what's actually
 * registered.
 */
export interface BuildKaizenGlobalArgs {
  registrations: ReadonlyArray<Pick<ToolRegistration, "schema" | "source">>;
  invoke: (name: string, args: unknown) => Promise<unknown>;
}

export function buildKaizenGlobal(args: BuildKaizenGlobalArgs): {
  tools?: Record<string, (a: unknown) => Promise<unknown>>;
  mcp?: Record<string, Record<string, (a: unknown) => Promise<unknown>>>;
  agents?: Record<string, (a: unknown) => Promise<unknown>>;
  skills?: Record<string, (a: unknown) => Promise<unknown>>;
  memory?: Record<string, (a: unknown) => Promise<unknown>>;
} {
  const { registrations, invoke } = args;
  const out: Record<string, unknown> = {};
  const ensure = (k: string): Record<string, unknown> => {
    if (!out[k]) out[k] = {};
    return out[k] as Record<string, unknown>;
  };
  const fn = (name: string) => (a: unknown) => invoke(name, a);

  for (const r of registrations) {
    const name = r.schema.name;
    const s = r.source;
    switch (s.kind) {
      case "local":
        ensure("tools")[name] = fn(name);
        break;
      case "mcp": {
        const server = normalizeServerName(s.server);
        const ns = ensure("mcp");
        if (!ns[server]) ns[server] = {};
        (ns[server] as Record<string, unknown>)[name] = fn(name);
        break;
      }
      case "agent":
        ensure("agents")[name] = fn(name);
        break;
      case "skill":
        ensure("skills")[name] = fn(name);
        break;
      case "memory":
        ensure("memory")[name] = fn(name);
        break;
    }
  }
  return out as ReturnType<typeof buildKaizenGlobal>;
}

export type SandboxRunResult =
  | { ok: true; returnValue: unknown; stdout: string }
  | { ok: false; errorName: string; errorMessage: string; stdout: string };

// Resolve the worker entry. When this file is loaded as the bundled
// dist/index.js, sandbox-entry.ts is one level up at the plugin root
// (kaizen's installer leaves source files in place alongside dist/).
// When loaded from source (tests, dev), it's a sibling.
const ENTRY_URL = (() => {
  const here = new URL(".", import.meta.url);
  const root = here.pathname.endsWith("/dist/") ? new URL("..", here) : here;
  return new URL("./sandbox-entry.ts", root).href;
})();

export async function runInSandbox(
  userCode: string,
  registry: SandboxRegistry,
  signal: AbortSignal,
  config: CodeModeConfig,
  emit?: (event: string, payload: unknown) => Promise<void>,
  turnId?: string,
  sessionId?: string,
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
            sessionId,
            log: (m) => { void emit?.("status:item-update", { key: `tool:${msg.id}`, value: m }); },
          });
          if (!settled) {
            try {
              worker.postMessage({ type: "tool-result", id: msg.id, ok: true, value } satisfies ToolResultMsg);
            } catch {
              // Worker may have been terminated by timeout/abort while the tool call was in flight.
            }
          }
        } catch (err) {
          if (!settled) {
            try {
              worker.postMessage({
                type: "tool-result",
                id: msg.id,
                ok: false,
                error: { name: (err as Error)?.name ?? "Error", message: String((err as Error)?.message ?? err) },
              } satisfies ToolResultMsg);
            } catch {
              // Worker may have been terminated by timeout/abort while the tool call was in flight.
            }
          }
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

    const regs: RegistrationMeta[] = (registry.listRegistrations?.() ?? []).map((r) => ({
      name: r.schema.name,
      source: r.source,
    }));
    const init: InitMsg = {
      type: "init",
      wrappedCode: wrap.wrapped,
      maxStdoutBytes: config.maxStdoutBytes,
      registrations: regs,
    };
    worker.postMessage(init satisfies HostToWorker);
  });
}
