import type { KaizenPlugin } from "kaizen/types";

const plugin: KaizenPlugin = {
  name: "llm-workflow",
  apiVersion: "3.0.0",
  permissions: { tier: "unscoped" },
  services: {
    provides: ["workflow:registry"],
    consumes: [
      "events:vocabulary",
      "driver:run-conversation",
      "tools:registry",
      "slash:registry",
      "agents:registry",
      "prompt:registry",
      "config:store",
    ],
  },

  async setup(_ctx) {
    // Wiring lands in Task 21.
  },

  async stop() {
    // Cleanup lands in Task 21.
  },
};

export default plugin;
