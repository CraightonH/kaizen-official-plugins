import type { KaizenPlugin } from "kaizen/types";
import type { McpBridgeService, ServerInfo } from "./public.d.ts";
import type { ToolsRegistryService } from "llm-events/public";
import { loadConfig, realDeps, type ResolvedServerConfig } from "./config.ts";
import { createClient } from "./client.ts";
import { makeBridgeService } from "./service.ts";
import { registerSlashCommands, type SlashRegistryLike } from "./slash.ts";

const VERSION = "0.1.0";

const plugin: KaizenPlugin = {
  name: "llm-mcp-bridge",
  apiVersion: "3.0.0",
  permissions: { tier: "unscoped" },
  services: { provides: ["mcp:bridge"], consumes: ["tools:registry", "llm-events:vocabulary"] },

  async setup(ctx) {
    const log = (m: string) => ctx.log(m);
    const cfgDeps = realDeps(log);
    const initial = await loadConfig(cfgDeps);
    for (const w of initial.warnings) log(`llm-mcp-bridge: ${w}`);

    ctx.defineService("mcp:bridge", { description: "Owns MCP server lifecycles; surfaces their tools and resources." });

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
      registry: { register: (s, h) => registry.register(s as any, h as any) },
      log,
      createClient: (cfg) => createClient(cfg, { log, version: VERSION }),
      initialServers: initial.servers,
    });
    ctx.provideService<McpBridgeService>("mcp:bridge", svc);

    // Slash commands (soft dependency).
    const slash = ctx.useService<SlashRegistryLike>("slash:registry");
    if (slash) {
      registerSlashCommands(slash, svc, async () => (await loadConfig(realDeps(log))).servers, log);
    } else {
      log("llm-mcp-bridge: slash:registry not present; /mcp:* commands not registered");
    }

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

    ctx.on("session:end", async () => {
      clearInterval(statusTimer);
      await ctx.emit("status:item-clear", { key: "mcp" });
      await svc.shutdownAll();
    });
  },
};

export default plugin;
