/// <reference lib="webworker" />
import type { HostToWorker, ToolInvokeMsg, ToolResultMsg, StdoutMsg, DoneMsg, ErrorMsg, RegistrationMeta } from "./rpc-types.ts";
import { bucketFor } from "./buckets.ts";

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

function invokeFn(name: string) {
  return (args: unknown) => new Promise((resolve, reject) => {
    const id = nextId();
    pending.set(id, { resolve, reject });
    const msg: ToolInvokeMsg = { type: "tool-invoke", id, name, args };
    (self as any).postMessage(msg);
  });
}

// Lazy proxy used as a fallback when no registrations are provided (e.g. by
// older callers or tests). Preserves the historical flat-shape behavior.
function makeLazyToolsProxy(): unknown {
  return new Proxy({}, {
    get(_t, prop) {
      if (typeof prop !== "string") return undefined;
      return invokeFn(prop);
    },
  });
}

function makeKaizen(registrations: RegistrationMeta[] | undefined): unknown {
  if (!registrations || registrations.length === 0) {
    // No metadata: fall back to a fully-lazy `kaizen.tools.*` proxy so that
    // legacy tests / callers without `listRegistrations` still work.
    return { tools: makeLazyToolsProxy() };
  }
  const out: Record<string, unknown> = {};
  const ensure = (k: string): Record<string, unknown> => {
    if (!out[k]) out[k] = {};
    return out[k] as Record<string, unknown>;
  };
  for (const r of registrations) {
    const name = r.name;
    const bucket = bucketFor(r.source);
    switch (bucket.kind) {
      case "tools":
        ensure("tools")[name] = invokeFn(name);
        break;
      case "mcp": {
        const ns = ensure("mcp");
        if (!ns[bucket.server]) ns[bucket.server] = {};
        (ns[bucket.server] as Record<string, unknown>)[name] = invokeFn(name);
        break;
      }
      case "agents":
        ensure("agents")[name] = invokeFn(name);
        break;
      case "skills":
        ensure("skills")[name] = invokeFn(name);
        break;
      case "memory":
        ensure("memory")[name] = invokeFn(name);
        break;
    }
  }
  return out;
}

// ---------- Main (single listener) ----------
// Capture references to Bun APIs BEFORE curateGlobals() removes them.
const AsyncFunctionCtor: FunctionConstructor = (async function () {}).constructor as unknown as FunctionConstructor;
const BunTranspilerCtor: (new (opts: { loader: string }) => { transformSync(s: string): string }) | undefined =
  (globalThis as any).Bun?.Transpiler;

function transpileToJs(code: string): string {
  if (!BunTranspilerCtor) return code;
  try {
    const t = new BunTranspilerCtor({ loader: "ts" });
    return t.transformSync(code);
  } catch {
    return code;
  }
}

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
    (globalThis as any).kaizen = makeKaizen(msg.registrations);
    (globalThis as any).console = makeConsole();
    try {
      // Transpile TS→JS before evaluating (strips type assertions like `as any`).
      // BunTranspilerCtor was captured before curateGlobals() removed Bun from globalThis.
      const jsCode = transpileToJs(msg.wrappedCode);
      // Shadow non-deletable/non-writable globals (like Bun, process) by passing them
      // as function parameters with undefined values. This prevents user code from
      // accessing them even though they're non-configurable on the worker global.
      const shadowedNames = ["Bun","process","require","fetch","XMLHttpRequest","WebSocket","setInterval","setImmediate","eval","Function"];
      const fn = new (AsyncFunctionCtor as any)("kaizen", ...shadowedNames, `return ${jsCode};`);
      const shadowedUndefineds = new Array(shadowedNames.length).fill(undefined);
      const value = await fn((globalThis as any).kaizen, ...shadowedUndefineds);
      (self as any).postMessage({ type: "done", returnValue: value } satisfies DoneMsg);
    } catch (err) {
      (self as any).postMessage({ type: "error", name: (err as Error)?.name ?? "Error", message: String((err as Error)?.message ?? err), stack: (err as Error)?.stack } satisfies ErrorMsg);
    }
  }
});
