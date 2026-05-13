// plugins/llm-local-tools/index.ts
import type { KaizenPlugin } from "kaizen/types";
import type { ToolsRegistryService } from "llm-tools-registry/public";
import { ALL_TOOLS } from "./tools.ts";

export const TOOL_NAMES = [
  "read", "write", "create", "edit", "glob", "grep", "bash", "web_fetch",
] as const;

const plugin: KaizenPlugin = {
  name: "llm-local-tools",
  apiVersion: "3.0.0",
  permissions: { tier: "trusted" },
  services: {
    consumes: ["tools:registry"],
    // events:vocabulary was listed as a topo-sort hint; this plugin never
    // calls useService("events:vocabulary"), so it has been removed per AGENTS.md.
  },

  async setup(ctx) {
    ctx.consumeService("tools:registry");
    const registry = ctx.useService<ToolsRegistryService>("tools:registry");
    if (!registry) throw new Error("llm-local-tools: tools:registry service not available");

    const unregisters: Array<() => void> = [];
    for (const tool of ALL_TOOLS) {
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
