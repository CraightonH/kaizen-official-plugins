import { describe, it, expect } from "bun:test";
import { makeBridgeService } from "../service.ts";
import type { ResolvedServerConfig } from "../config.ts";
import { makeMockClient } from "./mockServer.ts";

class FakeRegistry {
  registered = new Map<string, { schema: any; handler: any; unregistered: boolean }>();
  register(schema: any, handler: any) {
    if (this.registered.has(schema.name) && !this.registered.get(schema.name)!.unregistered) {
      throw new Error(`duplicate: ${schema.name}`);
    }
    this.registered.set(schema.name, { schema, handler, unregistered: false });
    return () => { this.registered.get(schema.name)!.unregistered = true; };
  }
  liveSchemas() { return [...this.registered.values()].filter((v) => !v.unregistered).map((v) => v.schema); }
}

function tick(ms = 0) { return new Promise((r) => setTimeout(r, ms)); }

const baseCfg = (name: string, overrides: Partial<ResolvedServerConfig> = {}): ResolvedServerConfig => ({
  name, transport: "stdio", enabled: true, timeoutMs: 30000, healthCheckMs: 60000, command: "true", ...overrides,
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
