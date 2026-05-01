import { describe, it, expect } from "bun:test";
import { ServerLifecycle } from "../../lifecycle.ts";
import { createClient } from "../../client.ts";
import type { ResolvedServerConfig } from "../../config.ts";

const RUN = process.env.KAIZEN_INTEGRATION === "1";
const maybe = RUN ? describe : describe.skip;

class FakeRegistry {
  registered = new Map<string, { schema: any; handler: any }>();
  register(s: any, h: any) { this.registered.set(s.name, { schema: s, handler: h }); return () => this.registered.delete(s.name); }
}

function tick(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

maybe("integration: @modelcontextprotocol/server-everything", () => {
  it("connects, lists tools, invokes one successfully", async () => {
    const reg = new FakeRegistry();
    const cfg: ResolvedServerConfig = {
      name: "everything",
      transport: "stdio",
      enabled: true,
      timeoutMs: 30000,
      healthCheckMs: 60000,
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-everything"],
    };
    const lc = new ServerLifecycle({
      cfg,
      registry: reg,
      log: (m) => console.error("[int]", m),
      createClient: (c) => createClient(c, { log: () => {}, version: "0.1.0-test" }),
      setTimeout: (cb, ms) => globalThis.setTimeout(cb, ms),
      clearTimeout: (h) => globalThis.clearTimeout(h as any),
      now: () => Date.now(),
    });
    lc.start();
    // Allow up to 15s for npx + handshake.
    for (let i = 0; i < 75; i++) {
      if (lc.info().status === "connected") break;
      await tick(200);
    }
    expect(lc.info().status).toBe("connected");
    const live = [...reg.registered.keys()].filter((n) => n.startsWith("mcp:everything:"));
    expect(live.length).toBeGreaterThan(0);
    // Invoke the first tool with a permissive empty-ish argument; some tools require args, so we just assert no protocol-level explosion.
    const first = reg.registered.get(live[0])!;
    const ac = new AbortController();
    let invokeErr: Error | undefined;
    try {
      await first.handler({}, { signal: ac.signal, callId: "int-1", log: () => {} });
    } catch (err) { invokeErr = err as Error; }
    // Either a clean result OR a structured tool error (e.g. invalid_arguments) is acceptable;
    // a transport-level explosion is not.
    if (invokeErr) {
      expect(invokeErr.message).not.toMatch(/EPIPE|ECONN|process exited|disconnected/i);
    }
    await lc.shutdown();
  });
});
