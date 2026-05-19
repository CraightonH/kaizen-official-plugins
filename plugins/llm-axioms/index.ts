import type { KaizenPlugin } from "kaizen/types";

const plugin: KaizenPlugin = {
  name: "llm-axioms",
  apiVersion: "3.0.0",
  permissions: { tier: "unscoped" },
  services: {
    provides: ["axioms:registry"],
    consumes: ["events:vocabulary"],
  },
  async setup(_ctx) {
    // Implementation lands in later tasks.
  },
  async stop() {},
};

export default plugin;
