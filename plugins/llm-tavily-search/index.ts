// plugins/llm-tavily-search/index.ts
import type { KaizenPlugin } from "kaizen/types";
import type { ConfigStoreService } from "llm-contracts/public";
import type { ToolsRegistryService } from "llm-tools-registry/public";
import { DEFAULT_CONFIG, CONFIG_SCHEMA } from "./config.ts";
import type { TavilyConfig } from "./public.d.ts";
import { schema, makeHandler } from "./tool.ts";

export const TOOL_NAMES = ["web_search"] as const;

let unregisterTool: (() => void) | undefined;

const plugin: KaizenPlugin = {
  name: "llm-tavily-search",
  apiVersion: "3.0.0",
  permissions: { tier: "trusted" },
  services: { consumes: ["tools:registry", "config:store"] },

  async setup(ctx) {
    const log = (m: string) => ctx.log?.(m);

    const registry = ctx.useService<ToolsRegistryService>("tools:registry");
    if (!registry) throw new Error("llm-tavily-search: tools:registry service not available");

    // Load config (topo-hint optional).
    let config: TavilyConfig = { ...DEFAULT_CONFIG };
    const cfgSvc = ctx.useService<ConfigStoreService>("config:store");
    if (cfgSvc) {
      try {
        cfgSvc.register<TavilyConfig>({
          plugin: "llm-tavily-search",
          defaults: { ...DEFAULT_CONFIG },
          schema: CONFIG_SCHEMA,
        });
        // Wait for secret-ref resolution before reading apiKey, otherwise
        // the first get() may return the `$ref` pointer object rather than
        // the resolved plaintext.
        await cfgSvc.ready();
        config = cfgSvc.get<TavilyConfig>("llm-tavily-search");
      } catch (e) {
        log(`llm-tavily-search: config:store register failed (${(e as Error).message}); using defaults`);
      }
    } else {
      log("llm-tavily-search: config:store unavailable; using DEFAULT_CONFIG");
    }

    if (!config.apiKey) {
      log(
        "llm-tavily-search: no API key found; web_search will error on call. " +
          "Run /config:set llm-tavily-search apiKey=<key>",
      );
    }

    const handler = makeHandler({ config, fetch, log: (m) => ctx.log(m) });
    unregisterTool = registry.register(schema, handler);
  },

  async stop() {
    try { unregisterTool?.(); } catch { /* idempotent */ }
    unregisterTool = undefined;
  },
};

export default plugin;
