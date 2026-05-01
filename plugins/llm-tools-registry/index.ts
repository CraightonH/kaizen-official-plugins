import type { KaizenPlugin } from "kaizen/types";
import { makeRegistry } from "./registry.ts";
import type { ToolsRegistryService } from "./registry.ts";

const plugin: KaizenPlugin = {
  name: "llm-tools-registry",
  apiVersion: "3.0.0",
  permissions: { tier: "trusted" },
  services: { provides: ["tools:registry"], consumes: ["llm-events:vocabulary"] },

  async setup(ctx) {
    const emit = (event: string, payload: unknown) => ctx.emit(event, payload);
    const registry = makeRegistry(emit);
    ctx.defineService("tools:registry", {
      description: "Central tool registry (single tool-execution chokepoint).",
    });
    ctx.provideService<ToolsRegistryService>("tools:registry", registry);
  },
};

export default plugin;
