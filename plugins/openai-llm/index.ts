import type { KaizenPlugin } from "kaizen/types";

const plugin: KaizenPlugin = {
  name: "openai-llm",
  apiVersion: "3.0.0",
  permissions: { tier: "trusted" },
  services: { provides: ["llm:complete"] },
  async setup(ctx) {
    // Filled in by Task 10.
    ctx.defineService("llm:complete", { description: "OpenAI-compatible chat completion provider." });
  },
};

export default plugin;
