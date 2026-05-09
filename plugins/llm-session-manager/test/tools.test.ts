import { describe, it, expect, mock } from "bun:test";
import { registerToolCommands, type ToolsRegistryLike } from "../tools.ts";
import type { CommandsApi } from "../commands.ts";

interface RegisteredTool {
  schema: { name: string; description: string; parameters: any };
  handler: (args: any, ctx: any) => Promise<unknown>;
}

function fakeRegistry(): { svc: ToolsRegistryLike; tools: RegisteredTool[] } {
  const tools: RegisteredTool[] = [];
  return {
    tools,
    svc: { register: (schema, handler) => { tools.push({ schema, handler } as RegisteredTool); return () => {}; } },
  };
}

function fakeCommands(overrides: Partial<CommandsApi> = {}): CommandsApi {
  return {
    clearSession: mock(async () => ({ from: null, to: "new", alias: null })),
    listSessions: mock(async () => []),
    resumeSession: mock(async () => ({ id: "x", alias: null })),
    renameActiveSession: mock(async (opts) => ({ id: "active", alias: opts.name })),
    deleteSession: mock(async (opts) => ({ deleted: opts.id })),
    ...overrides,
  };
}

const callCtx = () => ({ signal: new AbortController().signal, callId: "c1", log: () => {} });

describe("session tool peers", () => {
  it("registers exactly the five tool peers", () => {
    const { svc, tools } = fakeRegistry();
    registerToolCommands(svc, fakeCommands());
    expect(tools.map((t) => t.schema.name).sort()).toEqual([
      "session:delete",
      "session:list",
      "session:new",
      "session:rename",
      "session:resume",
    ]);
  });

  it("session:new returns the clearSession result verbatim", async () => {
    const cmds = fakeCommands({ clearSession: mock(async () => ({ from: "a", to: "b", alias: "owl" })) });
    const { svc, tools } = fakeRegistry();
    registerToolCommands(svc, cmds);
    const out = await tools.find((t) => t.schema.name === "session:new")!.handler({}, callCtx());
    expect(out).toEqual({ from: "a", to: "b", alias: "owl" });
  });

  it("session:list passes includeChildren and returns rows", async () => {
    const rows = [{ id: "s1", alias: "owl", harness: "h", metadata: {}, createdAt: 0, pluginFingerprint: [] }];
    const list = mock(async () => rows);
    const { svc, tools } = fakeRegistry();
    registerToolCommands(svc, fakeCommands({ listSessions: list as any }));
    const out = await tools.find((t) => t.schema.name === "session:list")!.handler({ includeChildren: true }, callCtx());
    expect(out).toBe(rows);
    expect((list as any).mock.calls[0][0]).toEqual({ includeChildren: true });
  });

  it("session:resume requires id_or_alias in schema", () => {
    const { svc, tools } = fakeRegistry();
    registerToolCommands(svc, fakeCommands());
    const t = tools.find((t) => t.schema.name === "session:resume")!;
    expect(t.schema.parameters.required).toContain("id_or_alias");
  });

  it("session:rename requires name in schema", () => {
    const { svc, tools } = fakeRegistry();
    registerToolCommands(svc, fakeCommands());
    const t = tools.find((t) => t.schema.name === "session:rename")!;
    expect(t.schema.parameters.required).toContain("name");
  });

  it("session:delete passes id and cascade", async () => {
    const del = mock(async () => ({ deleted: "x", replacement: "y" }));
    const { svc, tools } = fakeRegistry();
    registerToolCommands(svc, fakeCommands({ deleteSession: del as any }));
    const out = await tools.find((t) => t.schema.name === "session:delete")!.handler({ id: "x", cascade: true }, callCtx());
    expect(out).toEqual({ deleted: "x", replacement: "y" });
    expect((del as any).mock.calls[0][0]).toEqual({ id: "x", cascade: true });
  });

  it("session:rename surfaces underlying errors (no swallow)", async () => {
    const rename = mock(async () => { throw new Error("alias taken"); });
    const { svc, tools } = fakeRegistry();
    registerToolCommands(svc, fakeCommands({ renameActiveSession: rename as any }));
    const t = tools.find((t) => t.schema.name === "session:rename")!;
    await expect(t.handler({ name: "x" }, callCtx())).rejects.toThrow(/alias taken/);
  });
});
