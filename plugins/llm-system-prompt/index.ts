import type { KaizenPlugin } from "kaizen/types";

const plugin: KaizenPlugin = {
  name: "llm-system-prompt",
  apiVersion: "3.0.0",
  permissions: { tier: "trusted" },
  services: { provides: ["prompt:system"] },

  async setup(ctx) {
    ctx.defineService("prompt:system", {
      description: "Assembles the assistant's system prompt from registered sections.",
    });
    // implementation lands in Task 6
  },
};

export default plugin;
