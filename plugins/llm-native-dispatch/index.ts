import type { KaizenPlugin } from "kaizen/types";

const plugin: KaizenPlugin = {
  name: "llm-native-dispatch",
  apiVersion: "3.0.0",
  permissions: { tier: "trusted" },
  services: {
    provides: ["tool-dispatch:strategy"],
    consumes: ["tools:registry", "llm-events:vocabulary"],
  },
  async setup(ctx) {
    // Filled in by Task N5.
    ctx.defineService("tool-dispatch:strategy", { description: "Native OpenAI tool-calling dispatch strategy." });
  },
};

export default plugin;
