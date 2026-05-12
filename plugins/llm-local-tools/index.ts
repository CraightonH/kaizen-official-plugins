// plugins/llm-local-tools/index.ts
import type { KaizenPlugin } from "kaizen/types";
import type { ToolsRegistryService } from "llm-tools-registry/public";
import { ALL_TOOLS } from "./tools.ts";

export const TOOL_NAMES = ["read", "write", "create", "edit", "glob", "grep", "bash", "web_fetch"] as const;

const plugin: KaizenPlugin = {
  name: "llm-local-tools",
  apiVersion: "3.0.0",
  permissions: { tier: "trusted" },
  services: { consumes: ["tools:registry", "llm-events:vocabulary"] },

  async setup(ctx) {
    const registry = ctx.useService<ToolsRegistryService>("tools:registry");
    if (!registry) throw new Error("llm-local-tools: tools:registry service not available");

    const unregisters: Array<() => void> = [];
    for (const tool of ALL_TOOLS) {
      unregisters.push(registry.register(tool.schema, tool.handler));
    }

    return {
      async teardown() {
        for (const u of unregisters) {
          try { u(); } catch { /* idempotent */ }
        }
      },
    };
  },
};

export default plugin;
