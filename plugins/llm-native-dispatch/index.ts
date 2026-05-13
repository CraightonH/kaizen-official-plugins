import type { KaizenPlugin } from "kaizen/types";
import { makeStrategy } from "./strategy.ts";
import type { ToolDispatchStrategy } from "llm-contracts/public";

const plugin: KaizenPlugin = {
  name: "llm-native-dispatch",
  apiVersion: "3.0.0",
  permissions: { tier: "trusted" },
  services: {
    provides: ["dispatch:strategy"],
    // No hard consume edges: dispatch:strategy receives tools:registry via
    // the driver's deps injection (not via ctx), and events:vocabulary is not
    // used directly by this plugin. Both were topo-sort hints only.
  },

  async setup(ctx) {
    ctx.provideService<ToolDispatchStrategy>("dispatch:strategy", makeStrategy());
  },
};

export default plugin;
