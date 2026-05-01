import { describe, it, expect } from "bun:test";
import { registerSlashCommands } from "../slash.ts";
import type { ResolvedServerConfig } from "../config.ts";

class FakeSlashRegistry {
  registered: Array<{ manifest: any; handler?: any }> = [];
  register(manifest: any, handler: any) {
    this.registered.push({ manifest, handler });
    return () => { this.registered = this.registered.filter((e) => e.manifest.name !== manifest.name); };
  }
}

function makeBridge() {
  const events: string[] = [];
  return {
    events,
    list: () => [
      { name: "a", transport: "stdio" as const, status: "connected" as const, toolCount: 3, resourceCount: 0, promptCount: 0, reconnectAttempts: 0 },
      { name: "b", transport: "http" as const, status: "quarantined" as const, toolCount: 0, resourceCount: -1, promptCount: 0, reconnectAttempts: 5, lastError: "boom" },
    ],
    get: (n: string) => undefined,
    reconnect: async (n: string) => { events.push(`reconnect:${n}`); },
    reload: async (_: Map<string, ResolvedServerConfig>) => ({ added: ["c"], removed: [], updated: [] }),
    shutdown: async (n: string) => { events.push(`shutdown:${n}`); },
  };
}

describe("registerSlashCommands", () => {
  it("registers four namespaced plugin commands", () => {
    const sr = new FakeSlashRegistry();
    registerSlashCommands(sr as any, makeBridge() as any, async () => new Map(), () => {});
    const names = sr.registered.map((e) => e.manifest.name).sort();
    expect(names).toEqual(["mcp:disable", "mcp:list", "mcp:reconnect", "mcp:reload"]);
    for (const e of sr.registered) {
      expect(e.manifest.source).toBe("plugin");
    }
  });

  it("/mcp:list emits a status table", async () => {
    const sr = new FakeSlashRegistry();
    const out: string[] = [];
    registerSlashCommands(sr as any, makeBridge() as any, async () => new Map(), (m) => out.push(m));
    const list = sr.registered.find((e) => e.manifest.name === "mcp:list")!;
    const emitted: Array<{ name: string; payload: unknown }> = [];
    await list.handler({
      args: "",
      emit: async (n: string, p: unknown) => { emitted.push({ name: n, payload: p }); },
      signal: new AbortController().signal,
    });
    const last = emitted[emitted.length - 1];
    expect(last.name).toBe("conversation:system-message");
    expect(String((last.payload as any).content)).toContain("a");
    expect(String((last.payload as any).content)).toContain("connected");
    expect(String((last.payload as any).content)).toContain("quarantined");
  });

  it("/mcp:reload calls bridge.reload and reports diff", async () => {
    const sr = new FakeSlashRegistry();
    const out: string[] = [];
    registerSlashCommands(sr as any, makeBridge() as any, async () => new Map(), (m) => out.push(m));
    const r = sr.registered.find((e) => e.manifest.name === "mcp:reload")!;
    const emitted: Array<{ name: string; payload: unknown }> = [];
    await r.handler({
      args: "",
      emit: async (n: string, p: unknown) => { emitted.push({ name: n, payload: p }); },
      signal: new AbortController().signal,
    });
    const txt = String((emitted.at(-1)?.payload as any).content);
    expect(txt).toContain("added: c");
  });

  it("/mcp:reconnect <name> calls bridge.reconnect", async () => {
    const sr = new FakeSlashRegistry();
    const bridge = makeBridge();
    registerSlashCommands(sr as any, bridge as any, async () => new Map(), () => {});
    const r = sr.registered.find((e) => e.manifest.name === "mcp:reconnect")!;
    await r.handler({ args: "a", emit: async () => {}, signal: new AbortController().signal });
    expect(bridge.events).toContain("reconnect:a");
  });

  it("/mcp:reconnect with no arg emits usage", async () => {
    const sr = new FakeSlashRegistry();
    const bridge = makeBridge();
    registerSlashCommands(sr as any, bridge as any, async () => new Map(), () => {});
    const r = sr.registered.find((e) => e.manifest.name === "mcp:reconnect")!;
    const emitted: Array<{ name: string; payload: unknown }> = [];
    await r.handler({ args: "", emit: async (n, p) => { emitted.push({ name: n, payload: p }); }, signal: new AbortController().signal });
    expect(String((emitted.at(-1)?.payload as any).content).toLowerCase()).toContain("usage");
  });

  it("/mcp:disable <name> calls bridge.shutdown", async () => {
    const sr = new FakeSlashRegistry();
    const bridge = makeBridge();
    registerSlashCommands(sr as any, bridge as any, async () => new Map(), () => {});
    const r = sr.registered.find((e) => e.manifest.name === "mcp:disable")!;
    await r.handler({ args: "a", emit: async () => {}, signal: new AbortController().signal });
    expect(bridge.events).toContain("shutdown:a");
  });
});
