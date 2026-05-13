import type { KaizenPlugin } from "kaizen/types";
import { makeRegistry } from "./registry.ts";
import type { ToolsRegistryService } from "./registry.ts";
import { registerSlashCommands, type SlashRegistryLike } from "./slash.ts";

const plugin: KaizenPlugin = {
  name: "llm-tools-registry",
  apiVersion: "3.0.0",
  permissions: { tier: "unscoped" },
  services: { provides: ["tools:registry"], consumes: ["events:vocabulary"] },

  async setup(ctx) {
    const emit = (event: string, payload: unknown) => ctx.emit(event, payload);
    const registry = makeRegistry(emit);
    ctx.defineService("tools:registry", {
      description: "Central tool registry (single tool-execution chokepoint).",
    });
    ctx.provideService<ToolsRegistryService>("tools:registry", registry);

    // Defer slash registration to harness:start: setup() runs in dependency
    // order (we consume vocab, not slash:registry), so slash:registry isn't
    // guaranteed to be provided yet. By harness:start every plugin has
    // finished setup and useService resolves reliably.
    let unregs: Array<() => void> = [];
    ctx.on("harness:start", () => {
      try {
        const slash = ctx.useService<SlashRegistryLike>("slash:registry");
        if (slash) unregs = registerSlashCommands(slash, registry);
      } catch {
        // slash:registry absent in this harness — skip silently.
      }
    });
    ctx.on("harness:end", () => {
      for (const off of unregs) {
        try { off(); } catch { /* ignore */ }
      }
      unregs = [];
    });
  },
};

export default plugin;
