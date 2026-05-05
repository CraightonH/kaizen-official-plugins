import { describe, it, expect } from "bun:test";
import { ServerLifecycle } from "../lifecycle.ts";
import type { ResolvedServerConfig } from "../config.ts";
import { makeMockClient, type MockClient } from "./mockServer.ts";

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
  liveRegistrations() { return [...this.registered.values()].filter((v) => !v.unregistered); }
}

class FakeTimers {
  next = 1;
  scheduled = new Map<number, { cb: () => void; due: number }>();
  nowMs = 0;
  set(cb: () => void, ms: number) { const id = this.next++; this.scheduled.set(id, { cb, due: this.nowMs + ms }); return id; }
  clear(h: unknown) { this.scheduled.delete(h as number); }
  advance(ms: number) {
    this.nowMs += ms;
    const due = [...this.scheduled.entries()].filter(([, e]) => e.due <= this.nowMs).sort((a, b) => a[1].due - b[1].due);
    for (const [id, e] of due) {
      this.scheduled.delete(id);
      e.cb();
    }
  }
}

function tick(ms = 0) { return new Promise((r) => setTimeout(r, ms)); }

function baseCfg(overrides: Partial<ResolvedServerConfig> = {}): ResolvedServerConfig {
  return {
    name: "srv",
    transport: "stdio",
    enabled: true,
    timeoutMs: 30000,
    healthCheckMs: 60000,
    command: "true",
    ...overrides,
  };
}

describe("ServerLifecycle — happy path", () => {
  it("connects, lists tools, registers them with namespaced names", async () => {
    const c = makeMockClient({
      capabilities: { tools: {} },
      tools: [{ name: "do", description: "Do.", inputSchema: { type: "object", properties: {} } }],
    });
    const reg = new FakeRegistry();
    const t = new FakeTimers();
    const lc = new ServerLifecycle({
      cfg: baseCfg(),
      registry: reg,
      log: () => {},
      createClient: () => ({ client: c }),
      setTimeout: (cb, ms) => t.set(cb, ms),
      clearTimeout: (h) => t.clear(h),
      now: () => t.nowMs,
    });
    lc.start();
    await tick(); await tick();
    expect(lc.info().status).toBe("connected");
    expect(lc.info().toolCount).toBe(1);
    expect(reg.liveSchemas().map((s) => s.name)).toContain("mcp:srv:do");
  });

  it("ignores prompts capability (v0): does not list prompts, promptCount stays 0", async () => {
    const c = makeMockClient({
      capabilities: { tools: {}, prompts: {} },
      tools: [{ name: "t", description: "", inputSchema: { type: "object" } }],
    });
    const reg = new FakeRegistry();
    const t = new FakeTimers();
    const lc = new ServerLifecycle({
      cfg: baseCfg(),
      registry: reg,
      log: () => {},
      createClient: () => ({ client: c }),
      setTimeout: (cb, ms) => t.set(cb, ms),
      clearTimeout: (h) => t.clear(h),
      now: () => t.nowMs,
    });
    lc.start();
    await tick(); await tick();
    expect(lc.info().promptCount).toBe(0);
    expect(reg.liveSchemas().some((s) => s.name.startsWith("mcp:srv:") && s.name !== "mcp:srv:t")).toBe(false);
  });
});

describe("ServerLifecycle — disconnect + backoff", () => {
  it("on disconnect, schedules reconnect with 1s, 2s, 4s, 8s, 16s; quarantines on 6th failure", async () => {
    let attempts = 0;
    const c = makeMockClient({ capabilities: { tools: {} }, tools: [] });
    c.setBehavior({ connectFails: null });
    const reg = new FakeRegistry();
    const t = new FakeTimers();
    const lc = new ServerLifecycle({
      cfg: baseCfg(),
      registry: reg,
      log: () => {},
      createClient: () => {
        attempts++;
        if (attempts === 1) return { client: c };
        // subsequent attempts fail
        const f = makeMockClient({ connectFails: new Error("nope") });
        return { client: f };
      },
      setTimeout: (cb, ms) => t.set(cb, ms),
      clearTimeout: (h) => t.clear(h),
      now: () => t.nowMs,
      retryBudget: 5,
    });
    lc.start();
    await tick(); await tick();
    expect(lc.info().status).toBe("connected");
    // Simulate the transport closing
    c.simulateClose();
    await tick();
    expect(lc.info().status).toBe("reconnecting");
    // attempt 1 schedules at 1000ms
    t.advance(1000); await tick(); await tick();
    // attempt 2 -> 2000ms
    t.advance(2000); await tick(); await tick();
    // attempt 3 -> 4000ms
    t.advance(4000); await tick(); await tick();
    // attempt 4 -> 8000ms
    t.advance(8000); await tick(); await tick();
    // attempt 5 -> 16000ms (still under 60s cap)
    t.advance(16000); await tick(); await tick();
    expect(lc.info().status).toBe("quarantined");
    expect(lc.info().reconnectAttempts).toBeGreaterThanOrEqual(5);
  });

  it("tools registered before quarantine remain registered (no churn)", async () => {
    const c = makeMockClient({
      capabilities: { tools: {} },
      tools: [{ name: "t", description: "", inputSchema: { type: "object" } }],
    });
    const reg = new FakeRegistry();
    const t = new FakeTimers();
    let attempts = 0;
    const lc = new ServerLifecycle({
      cfg: baseCfg(),
      registry: reg,
      log: () => {},
      createClient: () => {
        attempts++;
        if (attempts === 1) return { client: c };
        return { client: makeMockClient({ connectFails: new Error("nope") }) };
      },
      setTimeout: (cb, ms) => t.set(cb, ms),
      clearTimeout: (h) => t.clear(h),
      now: () => t.nowMs,
    });
    lc.start();
    await tick(); await tick();
    c.simulateClose();
    for (const ms of [1000, 2000, 4000, 8000, 16000]) { t.advance(ms); await tick(); await tick(); }
    expect(lc.info().status).toBe("quarantined");
    expect(reg.liveSchemas().map((s) => s.name)).toContain("mcp:srv:t");
  });
});

describe("ServerLifecycle — health checks", () => {
  it("ping failure transitions to reconnecting", async () => {
    const c = makeMockClient({ capabilities: { tools: {} }, tools: [] });
    const reg = new FakeRegistry();
    const t = new FakeTimers();
    const lc = new ServerLifecycle({
      cfg: baseCfg({ healthCheckMs: 60000 }),
      registry: reg,
      log: () => {},
      createClient: () => ({ client: c }),
      setTimeout: (cb, ms) => t.set(cb, ms),
      clearTimeout: (h) => t.clear(h),
      now: () => t.nowMs,
    });
    lc.start();
    await tick(); await tick();
    expect(lc.info().status).toBe("connected");
    c.setBehavior({ pingFails: true });
    t.advance(60000); await tick(); await tick();
    expect(lc.info().status).toBe("reconnecting");
  });
});

describe("ServerLifecycle — forceReconnect", () => {
  it("clears quarantine and re-runs Phase 1", async () => {
    let attempts = 0;
    const reg = new FakeRegistry();
    const t = new FakeTimers();
    const c = makeMockClient({ capabilities: { tools: {} }, tools: [] });
    const lc = new ServerLifecycle({
      cfg: baseCfg(),
      registry: reg,
      log: () => {},
      createClient: () => {
        attempts++;
        if (attempts <= 5) return { client: makeMockClient({ connectFails: new Error("no") }) };
        return { client: c };
      },
      setTimeout: (cb, ms) => t.set(cb, ms),
      clearTimeout: (h) => t.clear(h),
      now: () => t.nowMs,
    });
    lc.start();
    await tick(); await tick();
    for (const ms of [1000, 2000, 4000, 8000, 16000]) { t.advance(ms); await tick(); await tick(); }
    expect(lc.info().status).toBe("quarantined");
    await lc.forceReconnect();
    await tick(); await tick();
    expect(lc.info().status).toBe("connected");
    expect(lc.info().reconnectAttempts).toBe(0);
  });
});

describe("ServerLifecycle — shutdown", () => {
  it("Phase 5 closes client and unregisters tools", async () => {
    const c = makeMockClient({
      capabilities: { tools: {} },
      tools: [{ name: "t", description: "", inputSchema: { type: "object" } }],
    });
    const reg = new FakeRegistry();
    const t = new FakeTimers();
    const lc = new ServerLifecycle({
      cfg: baseCfg(),
      registry: reg,
      log: () => {},
      createClient: () => ({ client: c }),
      setTimeout: (cb, ms) => t.set(cb, ms),
      clearTimeout: (h) => t.clear(h),
      now: () => t.nowMs,
    });
    lc.start();
    await tick(); await tick();
    expect(reg.liveSchemas().length).toBe(1);
    await lc.shutdown();
    expect(c.closeCount).toBe(1);
    expect(reg.liveSchemas().length).toBe(0);
  });
});

describe("ServerLifecycle — disabled config", () => {
  it("does not start when enabled=false", async () => {
    const reg = new FakeRegistry();
    const t = new FakeTimers();
    let created = 0;
    const lc = new ServerLifecycle({
      cfg: baseCfg({ enabled: false }),
      registry: reg,
      log: () => {},
      createClient: () => { created++; return { client: makeMockClient() }; },
      setTimeout: (cb, ms) => t.set(cb, ms),
      clearTimeout: (h) => t.clear(h),
      now: () => t.nowMs,
    });
    lc.start();
    await tick(); await tick();
    expect(lc.info().status).toBe("disabled");
    expect(created).toBe(0);
  });
});

describe("ServerLifecycle — registerWith source tagging", () => {
  it("registers MCP tools with source: { kind: 'mcp', server: <name> }", async () => {
    const c = makeMockClient({
      capabilities: { tools: {} },
      tools: [{ name: "search", description: "Search.", inputSchema: { type: "object", properties: {} } }],
    });
    const reg = new FakeRegistry();
    const t = new FakeTimers();
    const lc = new ServerLifecycle({
      cfg: baseCfg({ name: "github" }),
      registry: reg,
      log: () => {},
      createClient: () => ({ client: c }),
      setTimeout: (cb, ms) => t.set(cb, ms),
      clearTimeout: (h) => t.clear(h),
      now: () => t.nowMs,
    });
    lc.start();
    await tick(); await tick();
    expect(lc.info().status).toBe("connected");
    const registrations = reg.liveRegistrations();
    expect(registrations.length).toBe(1);
    const toolReg = registrations.find((r) => r.schema.name === "mcp:github:search");
    expect(toolReg).toBeDefined();
    expect(toolReg!.source).toEqual({ kind: "mcp", server: "github" });
  });

  it("tools from different servers get their respective server names in source", async () => {
    const reg = new FakeRegistry();
    const t = new FakeTimers();
    let attempt = 0;
    const cfgA = baseCfg({ name: "serverA" });
    const cfgB = baseCfg({ name: "serverB" });

    const makeLC = (cfg: ResolvedServerConfig, toolName: string) => {
      const c = makeMockClient({
        capabilities: { tools: {} },
        tools: [{ name: toolName, description: "", inputSchema: { type: "object" } }],
      });
      return new ServerLifecycle({
        cfg,
        registry: reg,
        log: () => {},
        createClient: () => ({ client: c }),
        setTimeout: (cb, ms) => t.set(cb, ms),
        clearTimeout: (h) => t.clear(h),
        now: () => t.nowMs,
      });
    };

    const lcA = makeLC(cfgA, "tool1");
    const lcB = makeLC(cfgB, "tool2");
    lcA.start();
    lcB.start();
    await tick(); await tick();

    const regs = reg.liveRegistrations();
    const regA = regs.find((r) => r.schema.name === "mcp:serverA:tool1");
    const regB = regs.find((r) => r.schema.name === "mcp:serverB:tool2");
    expect(regA!.source).toEqual({ kind: "mcp", server: "serverA" });
    expect(regB!.source).toEqual({ kind: "mcp", server: "serverB" });
  });
});

describe("ServerLifecycle — reconciliation on reconnect", () => {
  it("removed tools are unregistered, new tools registered, schema-changed tools updated", async () => {
    const reg = new FakeRegistry();
    const t = new FakeTimers();
    let attempts = 0;
    const c1 = makeMockClient({
      capabilities: { tools: {} },
      tools: [
        { name: "stays", description: "v1", inputSchema: { type: "object" } },
        { name: "removed", description: "", inputSchema: { type: "object" } },
      ],
    });
    const c2 = makeMockClient({
      capabilities: { tools: {} },
      tools: [
        { name: "stays", description: "v2", inputSchema: { type: "object" } },
        { name: "added", description: "", inputSchema: { type: "object" } },
      ],
    });
    const lc = new ServerLifecycle({
      cfg: baseCfg(),
      registry: reg,
      log: () => {},
      createClient: () => { attempts++; return { client: attempts === 1 ? c1 : c2 }; },
      setTimeout: (cb, ms) => t.set(cb, ms),
      clearTimeout: (h) => t.clear(h),
      now: () => t.nowMs,
    });
    lc.start();
    await tick(); await tick();
    expect(reg.liveSchemas().map((s) => s.name).sort()).toEqual(["mcp:srv:removed", "mcp:srv:stays"]);
    c1.simulateClose();
    t.advance(1000); await tick(); await tick();
    const live = reg.liveSchemas().map((s) => s.name).sort();
    expect(live).toEqual(["mcp:srv:added", "mcp:srv:stays"]);
    expect(reg.liveSchemas().find((s) => s.name === "mcp:srv:stays")!.description).toBe("v2");
  });
});
