import type { KaizenPlugin } from "kaizen/types";

const plugin: KaizenPlugin = {
  name: "llm-status-items",
  apiVersion: "3.0.0",
  permissions: { tier: "trusted" },
  services: { consumes: ["llm-events:vocabulary"] },
  async setup(ctx) {
    // Filled in by Task S5.
    ctx.consumeService("llm-events:vocabulary");
  },
};

export default plugin;
