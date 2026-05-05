import type { ResolvedServerConfig } from "./config.ts";
import type { McpClientLike, CreateClientResult } from "./client.ts";
import { ServerLifecycle, type LifecycleDeps, type RegistryLike } from "./lifecycle.ts";
import { makeReadMcpResourceTool, makeListMcpResourcesTool, type NamedClient } from "./registration.ts";
import type { ServerInfo, McpBridgeService } from "./public.d.ts";
import { detectConflicts } from "./names.ts";

export interface BridgeDeps {
  registry: RegistryLike;
  log: (msg: string) => void;
  emit?: (event: string, payload: unknown) => void | Promise<void>;
  createClient: (cfg: ResolvedServerConfig) => CreateClientResult;
  initialServers: Map<string, ResolvedServerConfig>;
  // Test injection points; default to globalThis equivalents.
  setTimeout?: (cb: () => void, ms: number) => unknown;
  clearTimeout?: (h: unknown) => void;
  now?: () => number;
}

export interface InternalBridge extends McpBridgeService {
  shutdownAll(): Promise<void>;
  reload(newConfig: Map<string, ResolvedServerConfig>): Promise<{ added: string[]; removed: string[]; updated: string[] }>;
}

export function makeBridgeService(deps: BridgeDeps): InternalBridge {
  const lifecycles = new Map<string, ServerLifecycle>();
  const setT = deps.setTimeout ?? ((cb, ms) => globalThis.setTimeout(cb, ms));
  const clrT = deps.clearTimeout ?? ((h) => globalThis.clearTimeout(h as any));
  const nowFn = deps.now ?? (() => Date.now());

  const makeLifecycle = (cfg: ResolvedServerConfig): ServerLifecycle => {
    const lcDeps: LifecycleDeps = {
      cfg,
      registry: deps.registry,
      log: deps.log,
      createClient: deps.createClient,
      setTimeout: setT,
      clearTimeout: clrT,
      now: nowFn,
    };
    return new ServerLifecycle(lcDeps);
  };

  // Register the two global resource tools once.
  const getClientByServer = (server: string): McpClientLike | undefined => lifecycles.get(server)?.getClient();
  const getHealthyClients = (): NamedClient[] => {
    const out: NamedClient[] = [];
    for (const [name, lc] of lifecycles) {
      const c = lc.getClient();
      if (c) out.push({ name, client: c });
    }
    return out;
  };
  const readReg = makeReadMcpResourceTool(getClientByServer);
  const listReg = makeListMcpResourcesTool(getHealthyClients);
  const unregisterRead = deps.registry.registerWith({ schema: readReg.schema as any, handler: readReg.handler as any, source: { kind: "local" } });
  const unregisterList = deps.registry.registerWith({ schema: listReg.schema as any, handler: listReg.handler as any, source: { kind: "local" } });

  // Start initial set.
  for (const [name, cfg] of deps.initialServers) {
    const lc = makeLifecycle(cfg);
    lifecycles.set(name, lc);
    lc.start();
  }

  // Emit conflict events for any normalized-name collisions.
  function emitConflicts(): void {
    const conflicts = detectConflicts([...lifecycles.keys()]);
    for (const c of conflicts) {
      void deps.emit?.("mcp:registration-conflict", { normalized: c.normalized, servers: c.servers });
    }
  }

  emitConflicts();

  function configsEqual(a: ResolvedServerConfig, b: ResolvedServerConfig): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  const svc: InternalBridge = {
    list(): ServerInfo[] {
      return [...lifecycles.values()].map((lc) => lc.info());
    },
    get(name: string) { return lifecycles.get(name)?.info(); },
    async reconnect(name: string) {
      const lc = lifecycles.get(name);
      if (!lc) throw new Error(`unknown server: ${name}`);
      await lc.forceReconnect();
    },
    async reload(newConfig: Map<string, ResolvedServerConfig>) {
      const added: string[] = []; const removed: string[] = []; const updated: string[] = [];
      // remove
      for (const [name, lc] of [...lifecycles]) {
        if (!newConfig.has(name)) {
          await lc.shutdown();
          lifecycles.delete(name);
          removed.push(name);
        }
      }
      // add or update
      for (const [name, cfg] of newConfig) {
        const existing = lifecycles.get(name);
        if (!existing) {
          const lc = makeLifecycle(cfg);
          lifecycles.set(name, lc);
          lc.start();
          added.push(name);
        } else {
          const prev = existing.config();
          if (!configsEqual(prev, cfg)) {
            await existing.shutdown();
            const lc = makeLifecycle(cfg);
            lifecycles.set(name, lc);
            lc.start();
            updated.push(name);
          }
        }
      }
      emitConflicts();
      return { added, removed, updated };
    },
    async shutdown(name: string) {
      const lc = lifecycles.get(name);
      if (!lc) return;
      await lc.shutdown();
      lifecycles.delete(name);
    },
    async shutdownAll() {
      for (const lc of lifecycles.values()) await lc.shutdown();
      lifecycles.clear();
      try { unregisterRead(); } catch { /* ignore */ }
      try { unregisterList(); } catch { /* ignore */ }
    },
  };

  return svc;
}

export type { ResolvedServerConfig };
