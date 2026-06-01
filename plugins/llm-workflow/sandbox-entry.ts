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
function stripExports(code: string): string {
  // AsyncFunction body scope doesn't allow `export` declarations.
  // Strip `export` keyword from named declarations so the transpiled
  // source runs correctly inside `new AsyncFunction(src)()`.
  return code
    .replace(/^export\s+default\s+/gm, "const __default__ = ")
    .replace(/^export\s+(const|let|var|function\*?|class|async\s+function\*?)\s/gm, "$1 ");
}

function transpileToJs(code: string): string {
  if (!BunTranspilerCtor) {
    return stripExports(code);
  }
  try {
    const transpiled = new BunTranspilerCtor({ loader: "ts" }).transformSync(code);
    return stripExports(transpiled);
  } catch {
    return stripExports(code);
  }
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
