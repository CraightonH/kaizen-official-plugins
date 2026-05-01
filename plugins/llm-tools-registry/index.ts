import type { KaizenPlugin } from "kaizen/types";

const plugin: KaizenPlugin = {
  name: "llm-tools-registry",
  apiVersion: "3.0.0",
  permissions: { tier: "trusted" },
  services: { provides: ["tools:registry"], consumes: ["llm-events:vocabulary"] },
  async setup(ctx) {
    // Filled in by Task R4.
    ctx.defineService("tools:registry", { description: "Central tool registry." });
  },
};

export default plugin;
