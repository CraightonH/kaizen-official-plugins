import { describe, it, expect } from "bun:test";
import { runInSandbox } from "../sandbox-host.ts";
import { DEFAULT_CONFIG } from "../config.ts";
import type { ToolsRegistryService, ToolSchema } from "llm-events/public";

const reg = (h: Record<string, (a:any)=>any> = {}): ToolsRegistryService => ({
  register: () => () => {},
  list: () => [] as ToolSchema[],
  invoke: async (n, a) => { const fn = h[n]; if (!fn) throw new Error(`unknown tool: ${n}`); return fn(a); },
});
const cfg = { ...DEFAULT_CONFIG, timeoutMs: 2000 };

describe("e2e sandbox safety", () => {
  it("dynamic import('node:fs') is rejected at wrap time", async () => {
    const r = await runInSandbox(`await import('node:fs')`, reg(), new AbortController().signal, cfg);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorName).toBe("SyntaxError");
  });

  it("static import is rejected at wrap time", async () => {
    const r = await runInSandbox(`import x from 'node:fs'`, reg(), new AbortController().signal, cfg);
    expect(r.ok).toBe(false);
  });

  it("require() is rejected", async () => {
    const r = await runInSandbox(`require('node:fs')`, reg(), new AbortController().signal, cfg);
    expect(r.ok).toBe(false);
  });

  it("process is undefined inside worker", async () => {
    const r = await runInSandbox(`typeof process`, reg(), new AbortController().signal, cfg);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.returnValue).toBe("undefined");
  });

  it("Bun is undefined inside worker", async () => {
    const r = await runInSandbox(`typeof Bun`, reg(), new AbortController().signal, cfg);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.returnValue).toBe("undefined");
  });

  it("fetch is undefined inside worker", async () => {
    const r = await runInSandbox(`typeof fetch`, reg(), new AbortController().signal, cfg);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.returnValue).toBe("undefined");
  });

  it("setInterval is undefined inside worker", async () => {
    const r = await runInSandbox(`typeof setInterval`, reg(), new AbortController().signal, cfg);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.returnValue).toBe("undefined");
  });

  it("setTimeout is allowed", async () => {
    const r = await runInSandbox(`await new Promise(r => setTimeout(r, 5)); 7;`, reg(), new AbortController().signal, cfg);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.returnValue).toBe(7);
  });

  it("kaizen.tools proxy fails for unregistered tool with registry message", async () => {
    const r = await runInSandbox(`try { await kaizen.tools.nope({}); 'unreachable' } catch (e) { (e as any).message }`, reg(), new AbortController().signal, cfg);
    expect(r.ok).toBe(true);
    if (r.ok) expect(String(r.returnValue)).toContain("unknown tool: nope");
  });

  it("multiple tool calls run sequentially and propagate values", async () => {
    let counter = 0;
    const r = await runInSandbox(
      `const a = await kaizen.tools.inc({}); const b = await kaizen.tools.inc({}); [a,b];`,
      reg({ inc: () => ++counter }),
      new AbortController().signal,
      cfg,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.returnValue).toEqual([1,2]);
  });

  it("infinite loop is killed by timeout, error name is TimeoutError", async () => {
    const r = await runInSandbox(`while(true){}`, reg(), new AbortController().signal, { ...cfg, timeoutMs: 150 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorName).toBe("TimeoutError");
  });

  it("AbortSignal mid-execution rejects with AbortError", async () => {
    const ac = new AbortController();
    const sleeper = (a: any) => new Promise((res) => setTimeout(() => res(a), 5000));
    setTimeout(() => ac.abort(), 30);
    await expect(runInSandbox(`await kaizen.tools.sleep({})`, reg({ sleep: sleeper as any }), ac.signal, cfg)).rejects.toThrow(/abort/i);
  });
});
