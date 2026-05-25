import type { KaizenPlugin } from "kaizen/types";
import type { ConfigStoreService, McpBridgeService, ServerInfo } from "llm-contracts/public";
import type { ToolsRegistryService } from "llm-tools-registry/public";
import pkg from "./package.json" with { type: "json" };
import type { McpBridgeConfig } from "./public.d.ts";
import { DEFAULT_CONFIG, CONFIG_SCHEMA } from "./config.ts";
import { resolveServers } from "./servers.ts";
import { createClient } from "./client.ts";
import { makeBridgeService } from "./service.ts";
import { registerSlashCommands, type SlashRegistryLike } from "./slash.ts";
import { registerToolPeers } from "./tools-peers.ts";

const VERSION = pkg.version;

const plugin: KaizenPlugin = {
  name: "llm-mcp-bridge",
  apiVersion: "3.0.0",
  permissions: { tier: "unscoped" },
  services: {
    provides: ["mcp:bridge"],
    // Topo-sort hints — kaizen uses `services.consumes` to order plugin
    // setup. `tools:registry` and `slash:registry` are both looked up via
    // optional `useService` in setup; declaring them here guarantees their
    // providers run first. Without these, `ctx.useService(...)` throws
    // "no provider" because kaizen has no edge to schedule us after them.
    consumes: ["tools:registry", "slash:registry", "config:store"],
  },

  async setup(ctx) {
    const log = (m: string) => ctx.log(m);

    // Load config (topo-hint optional). The `useService` + try/catch pattern
    // matches `llm-axioms` — graceful fallback to DEFAULT_CONFIG keeps fake-ctx
    // tests and degraded-harness boots working.
    let config: McpBridgeConfig = { ...DEFAULT_CONFIG };
    const cfgSvc = ctx.useService<ConfigStoreService>("config:store");
    if (cfgSvc) {
      try {
        cfgSvc.register<McpBridgeConfig>({
          plugin: "llm-mcp-bridge",
          defaults: { ...DEFAULT_CONFIG },
          schema: CONFIG_SCHEMA,
        });
        config = cfgSvc.get<McpBridgeConfig>("llm-mcp-bridge");
      } catch (e) {
        log(`llm-mcp-bridge: config:store register failed (${(e as Error).message}); using defaults`);
      }
    } else {
      log("llm-mcp-bridge: config:store unavailable; using DEFAULT_CONFIG");
    }

    // `loadResolved` re-reads through `cfgSvc` when available so `/mcp:reload`
    // picks up on-disk edits. Without `cfgSvc`, fall back to the boot-time
    // snapshot — reload becomes a re-resolution of the same servers map.
    const loadResolved = () => {
      const cfg = cfgSvc
        ? cfgSvc.get<McpBridgeConfig>("llm-mcp-bridge")
        : config;
      const res = resolveServers(cfg.servers, process.env);
      for (const w of res.warnings) log(`llm-mcp-bridge: ${w}`);
      return res.servers;
    };

    const initialServers = loadResolved();

    const registry = ctx.useService<ToolsRegistryService>("tools:registry");
    if (!registry) {
      log("llm-mcp-bridge: tools:registry service unavailable; MCP tools will not be registered");
      // Provide a no-op mcp:bridge so /mcp:list still works (returns empty).
      ctx.provideService<McpBridgeService>("mcp:bridge", {
        list: () => [],
        get: () => undefined,
        reconnect: async () => { throw new Error("tools:registry unavailable"); },
        reload: async () => ({ added: [], removed: [], updated: [] }),
        shutdown: async () => {},
      });
      return;
    }

    const svc = makeBridgeService({
      registry: {
        registerWith: (reg) => registry.registerWith(reg),
      },
      log,
      emit: (e, p) => { void ctx.emit(e, p); },
      createClient: (cfg) => createClient(cfg, { log, version: VERSION }),
      initialServers,
    });
    ctx.provideService<McpBridgeService>("mcp:bridge", svc);

    // Slash commands (soft dependency).
    const slash = ctx.useService<SlashRegistryLike>("slash:registry");
    if (slash) {
      registerSlashCommands(slash, svc, async () => loadResolved(), log);
    } else {
      log("llm-mcp-bridge: slash:registry not present; /mcp:* commands not registered");
    }

    // Tool peers — same surface, shaped for the LLM.
    registerToolPeers(
      { register: (s, h) => registry.register(s as any, h as any) },
      svc,
      async () => loadResolved(),
    );

    // Status-bar integration (best-effort). Hide the item entirely when no
    // servers are configured — emitting an empty value still renders the
    // bare key in the status bar ("mcp " with nothing after it).
    const updateStatus = () => {
      const rows = svc.list();
      const total = rows.length;
      if (total === 0) {
        void ctx.emit("status:item-clear", { key: "mcp" });
        return;
      }
      const connected = rows.filter((r: ServerInfo) => r.status === "connected").length;
      const quarantined = rows.some((r: ServerInfo) => r.status === "quarantined");
      void ctx.emit("status:item-update", { key: "mcp", value: `${connected}/${total}${quarantined ? " ⚠" : ""}` });
    };
    // Recompute on a 5s tick rather than wiring per-lifecycle callbacks (simpler; status bar already debounces).
    const statusTimer = setInterval(updateStatus, 5000);
    updateStatus();

    ctx.on("harness:end", async () => {
      clearInterval(statusTimer);
      await ctx.emit("status:item-clear", { key: "mcp" });
      await svc.shutdownAll();
    });
  },
};

export default plugin;
