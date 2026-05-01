import type { KaizenPlugin } from "kaizen/types";
import { makeStrategy } from "./strategy.ts";
import type { ToolDispatchStrategy } from "./strategy.ts";

const plugin: KaizenPlugin = {
  name: "llm-native-dispatch",
  apiVersion: "3.0.0",
  permissions: { tier: "trusted" },
  services: {
    provides: ["tool-dispatch:strategy"],
    consumes: ["tools:registry", "llm-events:vocabulary"],
  },

  async setup(ctx) {
    ctx.defineService("tool-dispatch:strategy", {
      description: "Native OpenAI tool-calling dispatch strategy.",
    });
    ctx.provideService<ToolDispatchStrategy>("tool-dispatch:strategy", makeStrategy());
  },
};

export default plugin;
