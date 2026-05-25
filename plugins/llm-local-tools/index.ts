// plugins/llm-local-tools/index.ts
import type { KaizenPlugin } from "kaizen/types";
import type { ConfigStoreService } from "llm-contracts/public";
import type { ToolsRegistryService } from "llm-tools-registry/public";
import { buildAllTools } from "./tools.ts";
import { DEFAULT_CONFIG, CONFIG_SCHEMA } from "./config.ts";
import type { LlmLocalToolsConfig } from "./public.d.ts";

export const TOOL_NAMES = [
  "read", "write", "create", "edit", "glob", "grep", "bash", "web_fetch",
] as const;

const plugin: KaizenPlugin = {
  name: "llm-local-tools",
  apiVersion: "3.0.0",
  permissions: { tier: "trusted" },
  services: {
    consumes: ["tools:registry", "config:store"],
    // events:vocabulary was listed as a topo-sort hint; this plugin never
    // calls useService("events:vocabulary"), so it has been removed per AGENTS.md.
    // config:store is a topo-hint optional dep — we fall back to DEFAULT_CONFIG
    // if the service is unavailable (keeps fake-ctx tests passing).
  },

  async setup(ctx) {
    const log = (m: string) => ctx.log?.(m);

    // Load config (topo-hint optional). Mirrors llm-axioms' pattern.
    let config: LlmLocalToolsConfig = { ...DEFAULT_CONFIG };
    const cfgSvc = ctx.useService<ConfigStoreService>("config:store");
    if (cfgSvc) {
      try {
        cfgSvc.register<LlmLocalToolsConfig>({
          plugin: "llm-local-tools",
          defaults: { ...DEFAULT_CONFIG },
          schema: CONFIG_SCHEMA,
        });
        config = cfgSvc.get<LlmLocalToolsConfig>("llm-local-tools");
      } catch (e) {
        log(`llm-local-tools: config:store register failed (${(e as Error).message}); using defaults`);
      }
    } else {
      log("llm-local-tools: config:store unavailable; using DEFAULT_CONFIG");
    }

    ctx.consumeService("tools:registry");
    const registry = ctx.useService<ToolsRegistryService>("tools:registry");
    if (!registry) throw new Error("llm-local-tools: tools:registry service not available");

    const unregisters: Array<() => void> = [];
    for (const tool of buildAllTools(config)) {
      unregisters.push(registry.register(tool.schema, tool.handler));
    }

    (plugin as any)._stop = () => {
      for (const u of unregisters.splice(0)) {
        try { u(); } catch { /* idempotent */ }
      }
    };
  },

  async stop() {
    const fn = (plugin as any)._stop;
    if (typeof fn === "function") fn();
  },
};

export default plugin;
