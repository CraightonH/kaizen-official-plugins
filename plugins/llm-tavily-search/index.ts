// plugins/llm-tavily-search/index.ts
import type { KaizenPlugin } from "kaizen/types";
import type { ToolsRegistryService } from "llm-tools-registry/public";
import { loadConfig, realDeps } from "./config.ts";
import { schema, makeHandler } from "./tool.ts";

export const TOOL_NAMES = ["web_search"] as const;

let unregisterTool: (() => void) | undefined;

const plugin: KaizenPlugin = {
  name: "llm-tavily-search",
  apiVersion: "3.0.0",
  permissions: { tier: "trusted" },
  services: { consumes: ["tools:registry"] },

  async setup(ctx) {
    ctx.consumeService("tools:registry");
    const registry = ctx.useService<ToolsRegistryService>("tools:registry");
    if (!registry) throw new Error("llm-tavily-search: tools:registry service not available");

    const config = await loadConfig(realDeps((m) => ctx.log(m)));
    if (!config.apiKey) {
      ctx.log(
        "llm-tavily-search: no API key found; web_search will error on call. " +
          "Set TAVILY_API_KEY or ~/.kaizen/plugins/llm-tavily-search/config.json",
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
