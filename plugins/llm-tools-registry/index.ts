import type { KaizenPlugin } from "kaizen/types";
import { makeRegistry } from "./registry.ts";
import type { ToolsRegistryService } from "./registry.ts";
import { registerSlashCommands, type SlashRegistryLike } from "./slash.ts";

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

    try {
      const slash = ctx.useService<SlashRegistryLike>("slash:registry");
      if (slash) registerSlashCommands(slash, registry);
    } catch {
      // slash:registry not present in this harness — skip silently.
    }
  },
};

export default plugin;
