import { describe, it, expect } from "bun:test";
import { makeWorkflowTool } from "../tool.ts";

function fakeEngine() {
  let lastCall: any = null;
  return {
    engine: {
      list: () => [],
      get: () => undefined,
      register: () => () => {},
      runInline: async (script: string, opts: any) => { lastCall = { kind: "inline", script, opts }; return { runId: "r1", ok: true, value: "v", tokensSpent: 0, agentCount: 0, durationMs: 1 }; },
      runByName: async (name: string, opts: any) => { lastCall = { kind: "name", name, opts }; return { runId: "r1", ok: true, value: name, tokensSpent: 0, agentCount: 0, durationMs: 1 }; },
    },
    lastCall: () => lastCall,
  };
}

describe("Workflow tool handler", () => {
  it("dispatches `script` to runInline", async () => {
    const f = fakeEngine();
    const tool = makeWorkflowTool({ engine: f.engine });
    const ctx = { signal: new AbortController().signal };
    const result = await tool.handler({ script: "export const meta = { name: 'x', description: 'y' };" }, ctx);
    expect(JSON.parse(result).ok).toBe(true);
    expect(f.lastCall().kind).toBe("inline");
  });

  it("dispatches `name` to runByName", async () => {
    const f = fakeEngine();
    const tool = makeWorkflowTool({ engine: f.engine });
    const ctx = { signal: new AbortController().signal };
    const result = await tool.handler({ name: "foo" }, ctx);
    expect(JSON.parse(result).value).toBe("foo");
    expect(f.lastCall().kind).toBe("name");
  });

  it("rejects when neither script/name/scriptPath provided", async () => {
    const f = fakeEngine();
    const tool = makeWorkflowTool({ engine: f.engine });
    const ctx = { signal: new AbortController().signal };
    await expect(tool.handler({}, ctx)).rejects.toThrow(/exactly one of/i);
  });

  it("rejects scriptPath in v1", async () => {
    const f = fakeEngine();
    const tool = makeWorkflowTool({ engine: f.engine });
    const ctx = { signal: new AbortController().signal };
    await expect(tool.handler({ scriptPath: "/tmp/x.ts" }, ctx)).rejects.toThrow(/scriptPath/);
  });
});
