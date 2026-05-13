import type { KaizenPlugin } from "kaizen/types";

const plugin: KaizenPlugin = {
  name: "llm-contracts",
  apiVersion: "3.0.0",
  permissions: { tier: "unscoped" },
  services: { provides: [], consumes: [] },

  async setup(ctx) {
    // Contract definitions are added by Phase 2 migration tasks.
    // Each migration adds one `ctx.defineService("<id>", { description: "..." });` line here.
    void ctx;
  },
};

export default plugin;
