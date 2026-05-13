import { describe, it, expect, mock } from "bun:test";
import { registerToolPeers, type ToolsRegistryLike } from "../tools-peers.ts";
import type { McpBridgeService, ServerInfo } from "llm-contracts/public";

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

function fakeBridge(overrides: Partial<McpBridgeService & { reload: any }> = {}): any {
  return {
    list: mock(() => [] as ServerInfo[]),
    get: mock(() => undefined),
    reconnect: mock(async () => {}),
    reload: mock(async () => ({ added: [], removed: [], updated: [] })),
    shutdown: mock(async () => {}),
    ...overrides,
  };
}

const callCtx = () => ({ signal: new AbortController().signal, callId: "c1", log: () => {} });

describe("mcp tool peers", () => {
  it("registers exactly mcp:list, mcp:reload, mcp:reconnect, mcp:disable", () => {
    const { svc, tools } = fakeRegistry();
    registerToolPeers(svc, fakeBridge(), async () => new Map());
    expect(tools.map((t) => t.schema.name).sort()).toEqual([
      "mcp:disable", "mcp:list", "mcp:reconnect", "mcp:reload",
    ]);
  });

  it("mcp:list returns bridge.list() rows verbatim", async () => {
    const rows: ServerInfo[] = [
      { name: "github", transport: "stdio", status: "connected", toolCount: 3, resourceCount: 0, promptCount: 0, reconnectAttempts: 0 } as any,
    ];
    const bridge = fakeBridge({ list: mock(() => rows) });
    const { svc, tools } = fakeRegistry();
    registerToolPeers(svc, bridge, async () => new Map());
    const out = await tools.find((t) => t.schema.name === "mcp:list")!.handler({}, callCtx());
    expect(out).toBe(rows);
  });

  it("mcp:reload re-reads config and applies bridge.reload()", async () => {
    const cfg = new Map();
    const reload = mock(async () => ({ added: ["a"], removed: [], updated: ["u"] }));
    const reloadFromDisk = mock(async () => cfg);
    const bridge = fakeBridge({ reload });
    const { svc, tools } = fakeRegistry();
    registerToolPeers(svc, bridge, reloadFromDisk);
    const out = await tools.find((t) => t.schema.name === "mcp:reload")!.handler({}, callCtx());
    expect(out).toEqual({ added: ["a"], removed: [], updated: ["u"] });
    expect((reloadFromDisk as any).mock.calls.length).toBe(1);
    expect((reload as any).mock.calls[0][0]).toBe(cfg);
  });

  it("mcp:reconnect calls bridge.reconnect with the server name", async () => {
    const reconnect = mock(async () => {});
    const bridge = fakeBridge({ reconnect });
    const { svc, tools } = fakeRegistry();
    registerToolPeers(svc, bridge, async () => new Map());
    const out = await tools.find((t) => t.schema.name === "mcp:reconnect")!.handler({ server: "github" }, callCtx());
    expect(out).toEqual({ ok: true });
    expect((reconnect as any).mock.calls[0]).toEqual(["github"]);
  });

  it("mcp:disable calls bridge.shutdown with the server name", async () => {
    const shutdown = mock(async () => {});
    const bridge = fakeBridge({ shutdown });
    const { svc, tools } = fakeRegistry();
    registerToolPeers(svc, bridge, async () => new Map());
    const out = await tools.find((t) => t.schema.name === "mcp:disable")!.handler({ server: "github" }, callCtx());
    expect(out).toEqual({ ok: true });
    expect((shutdown as any).mock.calls[0]).toEqual(["github"]);
  });

  it("mcp:reconnect requires server in schema", () => {
    const { svc, tools } = fakeRegistry();
    registerToolPeers(svc, fakeBridge(), async () => new Map());
    const t = tools.find((t) => t.schema.name === "mcp:reconnect")!;
    expect(t.schema.parameters.required).toContain("server");
  });
});
