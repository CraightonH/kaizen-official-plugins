import type { KaizenPlugin } from "kaizen/types";

const plugin: KaizenPlugin = {
  name: "llm-tool-approval",
  apiVersion: "3.0.0",
  permissions: { tier: "unscoped" },
  services: {
    consumes: ["ui:prompt", "ui:tool-renderer", "ui:channel", "ui:status", "slash:registry"],
  },

  async setup(_ctx) {
    // Wired in Task 18.
  },
};

export default plugin;
