import { describe, it, expect, mock } from "bun:test";
import plugin from "./index.ts";

function makeCtx(execImpl?: (bin: string, args: string[]) => Promise<any>) {
  const subs: Record<string, Function[]> = {};
  const emitted: Array<{ event: string; payload: any }> = [];
  return {
    subs,
    emitted,
    log: mock(() => {}),
    config: {},
    defineEvent: mock(() => {}),
    on: mock((event: string, h: Function) => { (subs[event] ??= []).push(h); }),
    emit: mock(async (event: string, payload?: any) => {
      emitted.push({ event, payload });
      return [];
    }),
    defineService: mock(() => {}),
    provideService: mock(() => {}),
    consumeService: mock(() => {}),
    useService: mock(() => undefined),
    secrets: { get: mock(async () => undefined), refresh: mock(async () => undefined) },
    exec: { run: mock(execImpl ?? (async () => ({ stdout: "main\n", stderr: "", exitCode: 0 }))) },
  } as any;
}

describe("claude-status-items", () => {
  it("has correct metadata + scoped tier with git", () => {
    expect(plugin.name).toBe("claude-status-items");
    expect(plugin.apiVersion).toBe("3.0.0");
    expect(plugin.permissions?.tier).toBe("scoped");
    expect(plugin.permissions?.exec?.binaries).toContain("git");
  });

  it("emits cwd and git.branch on session:start", async () => {
    const ctx = makeCtx();
    await plugin.setup(ctx);
    const handler = ctx.subs["session:start"]?.[0];
    expect(handler).toBeDefined();
    await handler!();
    const ids = ctx.emitted.filter((e) => e.event === "status:item-update").map((e) => e.payload.id);
    expect(ids).toContain("cwd");
    expect(ids).toContain("git.branch");
  });

  it("omits git.branch when not in a repo", async () => {
    const ctx = makeCtx(async () => ({ stdout: "", stderr: "fatal: not a git repository", exitCode: 128 }));
    await plugin.setup(ctx);
    await ctx.subs["session:start"]![0]!();
    const ids = ctx.emitted.filter((e) => e.event === "status:item-update").map((e) => e.payload.id);
    expect(ids).toContain("cwd");
    expect(ids).not.toContain("git.branch");
  });
});
