import { describe, it, expect } from "bun:test";
import { runInSandbox, type SandboxRunResult } from "../sandbox-host.ts";
import type { ToolsRegistryService, ToolSchema } from "llm-events/public";

function mockRegistry(handlers: Record<string, (args: any) => Promise<unknown> | unknown>): ToolsRegistryService {
  return {
    register: () => () => {},
    list: () => [] as ToolSchema[],
    invoke: async (name, args, _ctx) => {
      const h = handlers[name];
      if (!h) throw new Error(`unknown tool: ${name}`);
      return await h(args);
    },
  };
}

describe("runInSandbox", () => {
  const config = { timeoutMs: 5000, maxStdoutBytes: 16384, maxReturnBytes: 4096, maxBlocksPerResponse: 8, sandbox: "bun-worker" as const };

  it("evaluates plain expression and returns value", async () => {
    const r = await runInSandbox("1 + 1", mockRegistry({}), new AbortController().signal, config);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.returnValue).toBe(2);
  });

  it("calls a registered tool via kaizen.tools.X", async () => {
    const reg = mockRegistry({ echo: async (a: any) => ({ got: a.msg }) });
    const code = `const r = await kaizen.tools.echo({ msg: "hi" }); r;`;
    const r = await runInSandbox(code, reg, new AbortController().signal, config);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.returnValue).toEqual({ got: "hi" });
  });

  it("captures console.log output", async () => {
    const code = `console.log("a"); console.log("b"); 1;`;
    const r = await runInSandbox(code, mockRegistry({}), new AbortController().signal, config);
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain("a\n");
    expect(r.stdout).toContain("b\n");
  });

  it("throws inside user code → ok:false with error", async () => {
    const r = await runInSandbox(`throw new TypeError("boom")`, mockRegistry({}), new AbortController().signal, config);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorName).toBe("TypeError");
      expect(r.errorMessage).toBe("boom");
    }
  });

  it("times out runaway loop", async () => {
    const fast = { ...config, timeoutMs: 200 };
    const r = await runInSandbox(`while(true){}`, mockRegistry({}), new AbortController().signal, fast);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorName).toBe("TimeoutError");
  }, 5000);

  it("AbortSignal aborts worker", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    await expect(runInSandbox(`while(true){}`, mockRegistry({}), ac.signal, config)).rejects.toThrow(/abort/i);
  }, 5000);

  it("eval is not available", async () => {
    const r = await runInSandbox(`eval("1+1")`, mockRegistry({}), new AbortController().signal, config);
    expect(r.ok).toBe(false);
  });

  it("setInterval is not available", async () => {
    const r = await runInSandbox(`setInterval(()=>{}, 100); 1;`, mockRegistry({}), new AbortController().signal, config);
    expect(r.ok).toBe(false);
  });

  it("unknown tool surfaces registry error to user code", async () => {
    const code = `try { await kaizen.tools.nope({}); "unreachable"; } catch(e) { (e as any).message }`;
    const r = await runInSandbox(code, mockRegistry({}), new AbortController().signal, config);
    expect(r.ok).toBe(true);
    if (r.ok) expect(String(r.returnValue)).toContain("unknown tool: nope");
  });

  it("stdout overflow truncated by host", async () => {
    const small = { ...config, maxStdoutBytes: 16 };
    const code = `for (let i=0;i<100;i++) console.log("xxxxxxxxxxxxxxxx"); 1;`;
    const r = await runInSandbox(code, mockRegistry({}), new AbortController().signal, small);
    expect(r.ok).toBe(true);
    expect(Buffer.byteLength(r.stdout,"utf8")).toBeLessThanOrEqual(small.maxStdoutBytes + 64);
  });
});
