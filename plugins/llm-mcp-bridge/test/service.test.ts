import { describe, it, expect } from "bun:test";
import { makeBridgeService } from "../service.ts";
import type { ResolvedServerConfig } from "../servers.ts";
import { makeMockClient } from "./mockServer.ts";

class FakeRegistry {
  registered = new Map<string, { schema: any; handler: any; source: any; unregistered: boolean }>();
  register(schema: any, handler: any) {
    return this.registerWith({ schema, handler, source: { kind: "local" } });
  }
  registerWith(reg: { schema: any; handler: any; source: any }) {
    const { schema, handler, source } = reg;
    if (this.registered.has(schema.name) && !this.registered.get(schema.name)!.unregistered) {
      throw new Error(`duplicate: ${schema.name}`);
    }
    this.registered.set(schema.name, { schema, handler, source, unregistered: false });
    return () => { this.registered.get(schema.name)!.unregistered = true; };
  }
  liveSchemas() { return [...this.registered.values()].filter((v) => !v.unregistered).map((v) => v.schema); }
}

function tick(ms = 0) { return new Promise((r) => setTimeout(r, ms)); }

const baseCfg = (name: string, overrides: Partial<ResolvedServerConfig> = {}): ResolvedServerConfig => ({
  name, transport: "stdio", enabled: true, timeoutMs: 30000, healthCheckMs: 60000, command: "true", ...overrides,
});

describe("adapter: forwarding registerWith (regression for index.ts inline adapter)", () => {
  // Simulates the inline adapter in index.ts that wraps a ToolsRegistryService.
  // If registerWith is not forwarded, MCP tool registration throws at runtime.
  it("adapter with registerWith forwarding allows MCP tool registration", async () => {
    const underlying = new FakeRegistry();
    // Inline adapter mirroring what index.ts does (after the fix)
    const adapter = {
      register: (s: any, h: any) => underlying.register(s, h),
      registerWith: (reg: any) => underlying.registerWith(reg),
    };
    const svc = makeBridgeService({
      registry: adapter,
      log: () => {},
      createClient: () => ({
        client: makeMockClient({
          capabilities: { tools: {} },
          tools: [{ name: "tool1", description: "T.", inputSchema: { type: "object" } }],
        }),
      }),
      initialServers: new Map([["srv", baseCfg("srv")]]),
    });
    await tick(); await tick();
    // registerWith must have been called through the adapter — tool must be live
    expect(underlying.liveSchemas().map((s: any) => s.name)).toContain("mcp:srv:tool1");
    await svc.shutdownAll();
  });
});

describe("makeBridgeService", () => {
  it("registers global resource tools once", async () => {
    const reg = new FakeRegistry();
    const svc = makeBridgeService({
      registry: reg,
      log: () => {},
      createClient: () => ({ client: makeMockClient({ capabilities: { tools: {} }, tools: [] }) }),
      initialServers: new Map(),
    });
    expect(reg.liveSchemas().map((s) => s.name).sort()).toEqual(["list_mcp_resources", "read_mcp_resource"]);
    const readReg = reg.registered.get("read_mcp_resource");
    const listReg = reg.registered.get("list_mcp_resources");
    expect(readReg?.source).toEqual({ kind: "local" });
    expect(listReg?.source).toEqual({ kind: "local" });
    await svc.shutdownAll();
  });

  it("starts all enabled servers and exposes them via list()", async () => {
    const reg = new FakeRegistry();
    const a = baseCfg("a");
    const b = baseCfg("b", { enabled: false });
    const svc = makeBridgeService({
      registry: reg,
      log: () => {},
      createClient: () => ({ client: makeMockClient({ capabilities: { tools: {} }, tools: [] }) }),
      initialServers: new Map([[a.name, a], [b.name, b]]),
    });
    await tick(); await tick();
    const list = svc.list();
    expect(list.find((i) => i.name === "a")!.status).toBe("connected");
    expect(list.find((i) => i.name === "b")!.status).toBe("disabled");
    await svc.shutdownAll();
  });

  it("reload adds, removes, updates", async () => {
    const reg = new FakeRegistry();
    const svc = makeBridgeService({
      registry: reg,
      log: () => {},
      createClient: () => ({ client: makeMockClient({ capabilities: { tools: {} }, tools: [] }) }),
      initialServers: new Map([
        ["keep", baseCfg("keep")],
        ["change", baseCfg("change", { command: "old" })],
        ["remove", baseCfg("remove")],
      ]),
    });
    await tick(); await tick();
    const diff = await svc.reload(new Map([
      ["keep", baseCfg("keep")],
      ["change", baseCfg("change", { command: "new" })],
      ["add", baseCfg("add")],
    ]));
    expect(diff.added).toEqual(["add"]);
    expect(diff.removed).toEqual(["remove"]);
    expect(diff.updated).toEqual(["change"]);
    await tick(); await tick();
    expect(svc.list().map((i) => i.name).sort()).toEqual(["add", "change", "keep"]);
    await svc.shutdownAll();
  });

  it("emits mcp:registration-conflict when two server names normalize to the same identifier", async () => {
    const reg = new FakeRegistry();
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const svc = makeBridgeService({
      registry: reg,
      log: () => {},
      emit: (e, p) => { emitted.push({ event: e, payload: p }); },
      createClient: () => ({ client: makeMockClient({ capabilities: { tools: {} }, tools: [] }) }),
      initialServers: new Map([
        ["foo-bar", baseCfg("foo-bar")],
        ["foo_bar", baseCfg("foo_bar")],
      ]),
    });
    await tick();
    const conflicts = emitted.filter((e) => e.event === "mcp:registration-conflict");
    expect(conflicts).toHaveLength(1);
    const payload = conflicts[0].payload as { normalized: string; servers: string[] };
    expect(payload.normalized).toBe("foo_bar");
    expect(payload.servers.sort()).toEqual(["foo-bar", "foo_bar"].sort());
    await svc.shutdownAll();
  });

  it("emits mcp:registration-conflict after reload introduces a collision", async () => {
    const reg = new FakeRegistry();
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const svc = makeBridgeService({
      registry: reg,
      log: () => {},
      emit: (e, p) => { emitted.push({ event: e, payload: p }); },
      createClient: () => ({ client: makeMockClient({ capabilities: { tools: {} }, tools: [] }) }),
      initialServers: new Map([["solo", baseCfg("solo")]]),
    });
    await tick();
    expect(emitted.filter((e) => e.event === "mcp:registration-conflict")).toHaveLength(0);
    // "solo" and "solo.v2" do NOT collide; "foo-bar" and "foo_bar" DO collide
    await svc.reload(new Map([
      ["foo-bar", baseCfg("foo-bar")],
      ["foo_bar", baseCfg("foo_bar")],
    ]));
    await tick();
    const conflicts = emitted.filter((e) => e.event === "mcp:registration-conflict");
    expect(conflicts).toHaveLength(1);
    const payload = conflicts[0].payload as { normalized: string; servers: string[] };
    expect(payload.normalized).toBe("foo_bar");
    expect(payload.servers.sort()).toEqual(["foo-bar", "foo_bar"].sort());
    await svc.shutdownAll();
  });

  it("get(name) returns undefined for unknown server", async () => {
    const reg = new FakeRegistry();
    const svc = makeBridgeService({
      registry: reg, log: () => {},
      createClient: () => ({ client: makeMockClient() }),
      initialServers: new Map(),
    });
    expect(svc.get("missing")).toBeUndefined();
    await svc.shutdownAll();
  });

  it("shutdown(name) closes one server and unregisters its tools", async () => {
    const reg = new FakeRegistry();
    const svc = makeBridgeService({
      registry: reg, log: () => {},
      createClient: () => ({
        client: makeMockClient({
          capabilities: { tools: {} },
          tools: [{ name: "t", description: "", inputSchema: { type: "object" } }],
        }),
      }),
      initialServers: new Map([["a", baseCfg("a")]]),
    });
    await tick(); await tick();
    expect(reg.liveSchemas().map((s) => s.name)).toContain("mcp:a:t");
    await svc.shutdown("a");
    expect(reg.liveSchemas().map((s) => s.name)).not.toContain("mcp:a:t");
    await svc.shutdownAll();
  });
});
