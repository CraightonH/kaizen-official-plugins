import type { KaizenPlugin } from "kaizen/types";

const plugin: KaizenPlugin = {
  name: "llm-slash-commands",
  apiVersion: "3.0.0",
  permissions: { tier: "trusted" },
  services: { provides: ["slash:registry"] },
  async setup(ctx) {
    // Filled in by Task 10.
    ctx.defineService("slash:registry", { description: "Slash command registry." });
  },
};

export default plugin;
