// plugins/llm-local-tools/test/tools/bash.test.ts
import { describe, it, expect } from "bun:test";
import { schema, handler } from "../../tools/bash.ts";

function makeCtx(signal?: AbortSignal) {
  return { signal: signal ?? new AbortController().signal, callId: "c1", log: () => {} } as any;
}

describe("bash tool", () => {
  it("schema metadata", () => {
    expect(schema.name).toBe("bash");
    expect(schema.tags).toEqual(["local", "shell"]);
  });

  it("captures stdout", async () => {
    const r: any = await handler({ command: "echo hello" }, makeCtx());
    expect(r.exit_code).toBe(0);
    expect(r.output).toContain("hello");
    expect(r.killed_by_timeout).toBe(false);
  });

  it("captures stderr in same stream", async () => {
    const r: any = await handler({ command: "echo out; echo err 1>&2" }, makeCtx());
    expect(r.exit_code).toBe(0);
    expect(r.output).toContain("out");
    expect(r.output).toContain("err");
  });

  it("non-zero exit reflected in exit_code", async () => {
    const r: any = await handler({ command: "exit 7" }, makeCtx());
    expect(r.exit_code).toBe(7);
  });

  it("timeout kills the process and reports partial output", async () => {
    const r: any = await handler({ command: "echo before; sleep 30", timeout: 1000 }, makeCtx());
    expect(r.killed_by_timeout).toBe(true);
    expect(r.output).toContain("before");
    expect(r.output).toContain("[killed: timeout after");
    expect(r.exit_code).not.toBe(0);
  }, 8000);

  it("rejects run_in_background: true", async () => {
    await expect(handler({ command: "echo x", run_in_background: true }, makeCtx()))
      .rejects.toThrow(/run_in_background/i);
  });

  it("middle-truncates output past cap", async () => {
    // Generate >256KB of output; check head + tail preserved.
    const cmd = `node -e "for (let i=0;i<300000;i++) process.stdout.write('A'); process.stdout.write('END');"`;
    const r: any = await handler({ command: cmd, timeout: 30000 }, makeCtx());
    expect(r.truncated).toBe(true);
    expect(r.output).toContain("[truncated:");
    expect(r.output).toContain("END");
  });

  it("aborts when ctx.signal aborts mid-run", async () => {
    const ac = new AbortController();
    const promise = handler({ command: "sleep 5", timeout: 30000 }, makeCtx(ac.signal));
    setTimeout(() => ac.abort(), 200);
    const r: any = await promise;
    expect(r.exit_code).not.toBe(0);
  });
});
