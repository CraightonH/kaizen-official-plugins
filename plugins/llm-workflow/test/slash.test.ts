import { describe, it, expect } from "bun:test";
import { makeSlashHandlers } from "../slash.ts";

function fakeEngine(manifests: any[]) {
  return {
    list: () => manifests,
    get: (n: string) => manifests.find((m) => m.meta.name === n),
    register: () => () => {},
    runInline: async () => ({ runId: "r1", ok: true, value: null, tokensSpent: 0, agentCount: 0, durationMs: 1 }),
    runByName: async (n: string, opts: any) => ({ runId: "r1", ok: true, value: `ran:${n}:${JSON.stringify(opts?.args ?? null)}`, tokensSpent: 0, agentCount: 0, durationMs: 1 }),
  };
}

function fakeCmdCtx(args: string) {
  const printed: string[] = [];
  return {
    args,
    printed,
    print: async (s: string) => { printed.push(s); },
  };
}

describe("slash handlers", () => {
  it("/workflows:list — empty", async () => {
    const h = makeSlashHandlers({ engine: fakeEngine([]) });
    const ctx = fakeCmdCtx("");
    await h.listHandler(ctx as any);
    expect(ctx.printed[0]).toMatch(/no workflows/i);
  });

  it("/workflows:list — items", async () => {
    const h = makeSlashHandlers({ engine: fakeEngine([
      { meta: { name: "foo", description: "Desc foo" }, scope: "user", sourcePath: "/u/foo.ts", source: "" },
      { meta: { name: "bar", description: "Desc bar" }, scope: "project", sourcePath: "/p/bar.ts", source: "" },
    ]) });
    const ctx = fakeCmdCtx("");
    await h.listHandler(ctx as any);
    expect(ctx.printed[0]).toContain("foo");
    expect(ctx.printed[0]).toContain("bar");
  });

  it("/workflows:get prints manifest + source", async () => {
    const h = makeSlashHandlers({ engine: fakeEngine([
      { meta: { name: "foo", description: "Desc foo" }, scope: "user", sourcePath: "/u/foo.ts", source: "export const meta = {...}" },
    ]) });
    const ctx = fakeCmdCtx("foo");
    await h.getHandler(ctx as any);
    expect(ctx.printed[0]).toContain("foo");
    expect(ctx.printed[0]).toContain("Desc foo");
    expect(ctx.printed[0]).toContain("/u/foo.ts");
    expect(ctx.printed[0]).toContain("export const meta");
  });

  it("/workflows:run dispatches with parsed JSON args", async () => {
    const h = makeSlashHandlers({ engine: fakeEngine([
      { meta: { name: "demo", description: "d" }, scope: "user", sourcePath: "/u/demo.ts", source: "" },
    ]) });
    const ctx = fakeCmdCtx('demo {"x":1}');
    await h.runHandler(ctx as any);
    const joined = ctx.printed.join("\n");
    expect(joined).toContain(`ran:demo:{"x":1}`);
  });

  it("/workflows:run rejects malformed JSON args", async () => {
    const h = makeSlashHandlers({ engine: fakeEngine([
      { meta: { name: "demo", description: "d" }, scope: "user", sourcePath: "/u/demo.ts", source: "" },
    ]) });
    const ctx = fakeCmdCtx("demo {not-json}");
    await h.runHandler(ctx as any);
    expect(ctx.printed[0]).toMatch(/invalid JSON/i);
  });
});
