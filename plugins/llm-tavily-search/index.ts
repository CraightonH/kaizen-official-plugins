// plugins/llm-tavily-search/index.ts
import type { KaizenPlugin } from "kaizen/types";
import type { ConfigStoreService } from "llm-contracts/public";
import type { ToolsRegistryService } from "llm-tools-registry/public";
import { DEFAULT_CONFIG } from "./defaults.ts";
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
    ctx.consumeService("tools:registry");
    ctx.consumeService("config:store");

    const registry = ctx.useService<ToolsRegistryService>("tools:registry");
    if (!registry) throw new Error("llm-tavily-search: tools:registry service not available");

    const cfgSvc = ctx.useService<ConfigStoreService>("config:store");
    if (!cfgSvc) throw new Error("llm-tavily-search: config:store service not available");

    cfgSvc.register<TavilyConfig>({
      plugin: "llm-tavily-search",
      defaults: { ...DEFAULT_CONFIG },
      schema: {
        apiKey: { type: "string" },
        endpoint: { type: "string", min: 1 },
        defaultMaxResults: { type: "number", integer: true, min: 1, max: 20 },
        defaultSearchDepth: { type: "enum", values: ["basic", "advanced"] },
        defaultIncludeAnswer: { type: "boolean" },
        requestTimeoutMs: { type: "number", min: 1 },
      },
      envVars: { apiKey: "TAVILY_API_KEY" },
    });
    const config = cfgSvc.get<TavilyConfig>("llm-tavily-search");

    if (!config.apiKey) {
      ctx.log(
        "llm-tavily-search: no API key found; web_search will error on call. " +
          "Set TAVILY_API_KEY or run /config:set llm-tavily-search apiKey=<key>",
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
