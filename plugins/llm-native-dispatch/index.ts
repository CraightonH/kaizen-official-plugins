import type { KaizenPlugin } from "kaizen/types";
import { makeStrategy } from "./strategy.ts";
import type { ToolDispatchStrategy } from "llm-contracts/public";

const plugin: KaizenPlugin = {
  name: "llm-native-dispatch",
  apiVersion: "3.0.0",
  permissions: { tier: "trusted" },
  services: {
    provides: ["dispatch:strategy"],
    consumes: ["tools:registry", "events:vocabulary"],
  },

  async setup(ctx) {
    ctx.provideService<ToolDispatchStrategy>("dispatch:strategy", makeStrategy());
  },
};

export default plugin;
