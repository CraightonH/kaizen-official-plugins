// plugins/llm-local-tools/index.ts
import type { KaizenPlugin } from "kaizen/types";
import type { ToolSchema } from "llm-events/public";
import { ALL_TOOLS } from "./tools.ts";

interface ToolsRegistryService {
  register(schema: ToolSchema, handler: (args: any, ctx: any) => Promise<unknown>): () => void;
  list(filter?: { tags?: string[]; names?: string[] }): ToolSchema[];
  invoke(name: string, args: unknown, ctx: any): Promise<unknown>;
}

export const TOOL_NAMES = ["read", "write", "create", "edit", "glob", "grep", "bash"] as const;

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
    ctx.log?.(`llm-local-tools: registered ${ALL_TOOLS.length} tools`);

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
