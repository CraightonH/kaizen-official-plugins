import type { KaizenPlugin } from "kaizen/types";

const plugin: KaizenPlugin = {
  name: "claude-skills",
  apiVersion: "3.0.0",
  permissions: { tier: "unscoped" },
  services: { consumes: ["skills:registry", "config:store"] },

  async setup(ctx) {
    ctx.consumeService("skills:registry");
    ctx.consumeService("config:store");
    // Lifecycle fleshed out in Task 8.
  },

  async stop() {
    // Drained in Task 8.
  },
};

export default plugin;
