/// <reference lib="webworker" />
import type { HostToWorker, ToolInvokeMsg, ToolResultMsg, StdoutMsg, DoneMsg, ErrorMsg } from "./rpc-types.ts";

declare const self: DedicatedWorkerGlobalScope;

// ---------- Curate globals ----------
const ALLOW_KEYS = new Set<string>([
  "self","globalThis","console","JSON","Math","Date","Promise","Array","Object",
  "String","Number","Boolean","RegExp","Error","TypeError","RangeError","SyntaxError",
  "Map","Set","WeakMap","WeakSet","Symbol","BigInt","Uint8Array","Int8Array","Uint16Array",
  "Int16Array","Uint32Array","Int32Array","Float32Array","Float64Array","ArrayBuffer",
  "Reflect","Proxy","Buffer","TextEncoder","TextDecoder",
  "setTimeout","clearTimeout","queueMicrotask",
  "kaizen", "postMessage", "addEventListener", "removeEventListener", "onmessage", "onerror",
]);

function curateGlobals(): void {
  const g = self as unknown as Record<string, unknown>;
  for (const k of Object.getOwnPropertyNames(g)) {
    if (!ALLOW_KEYS.has(k)) {
      try { delete g[k]; } catch { try { (g as any)[k] = undefined; } catch {} }
    }
  }
  // Belt-and-suspenders: explicitly null out known dangerous keys even if listed in ALLOW.
  for (const k of ["Bun","process","require","module","__dirname","__filename","fetch","XMLHttpRequest","WebSocket","EventSource","setInterval","setImmediate","eval","Function","import"]) {
    try { (g as any)[k] = undefined; } catch {}
  }
  // Also neutralize Function constructor reachable via (()=>{}).constructor.
  try {
    const FnCtor = (function(){}).constructor;
    if (FnCtor) {
      (FnCtor as any).prototype.constructor = function blocked() { throw new Error("Function constructor disabled in sandbox"); };
    }
  } catch {}
}

// ---------- Stdout capture ----------
let stdoutBytes = 0;
let stdoutCap = 16384;
function postStdout(chunk: string): void {
  if (stdoutBytes >= stdoutCap) return;
  stdoutBytes += Buffer.byteLength(chunk, "utf8");
  const msg: StdoutMsg = { type: "stdout", chunk };
  (self as any).postMessage(msg);
}
function inspect(v: unknown): string {
  try {
    if (typeof v === "string") return v;
    return JSON.stringify(v);
  } catch { return String(v); }
}
function makeConsole() {
  const fmt = (args: unknown[]) => args.map(inspect).join(" ");
  return {
    log: (...a: unknown[]) => postStdout(fmt(a) + "\n"),
    info: (...a: unknown[]) => postStdout(fmt(a) + "\n"),
    debug: (...a: unknown[]) => postStdout(fmt(a) + "\n"),
    warn: (...a: unknown[]) => postStdout(fmt(a) + "\n"),
    error: (...a: unknown[]) => postStdout("[error] " + fmt(a) + "\n"),
  };
}

// ---------- Tool RPC Proxy ----------
type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void };
const pending = new Map<string, Pending>();
let counter = 0;
function nextId(): string { return `c${++counter}`; }

function makeKaizen(): unknown {
  const toolsProxy = new Proxy({}, {
    get(_t, prop) {
      if (typeof prop !== "string") return undefined;
      return (args: unknown) => new Promise((resolve, reject) => {
        const id = nextId();
        pending.set(id, { resolve, reject });
        const msg: ToolInvokeMsg = { type: "tool-invoke", id, name: prop, args };
        (self as any).postMessage(msg);
      });
    },
  });
  return { tools: toolsProxy };
}

// ---------- Main (single listener) ----------
const AsyncFunctionCtor: FunctionConstructor = (async function () {}).constructor as unknown as FunctionConstructor;

self.addEventListener("message", async (ev: MessageEvent<HostToWorker>) => {
  const msg = ev.data;
  if (msg.type === "tool-result") {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.value);
    else p.reject(Object.assign(new Error(msg.error?.message ?? "tool error"), { name: msg.error?.name ?? "Error" }));
    return;
  }
  if (msg.type === "init") {
    stdoutCap = msg.maxStdoutBytes;
    curateGlobals();
    (globalThis as any).kaizen = makeKaizen();
    (globalThis as any).console = makeConsole();
    try {
      const fn = new (AsyncFunctionCtor as any)("kaizen", `return ${msg.wrappedCode};`);
      const value = await fn((globalThis as any).kaizen);
      (self as any).postMessage({ type: "done", returnValue: value } satisfies DoneMsg);
    } catch (err) {
      (self as any).postMessage({ type: "error", name: (err as Error)?.name ?? "Error", message: String((err as Error)?.message ?? err), stack: (err as Error)?.stack } satisfies ErrorMsg);
    }
  }
});
