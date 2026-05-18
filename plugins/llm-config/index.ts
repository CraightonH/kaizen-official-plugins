import type { KaizenPlugin } from "kaizen/types";

const plugin: KaizenPlugin = {
  name: "llm-config",
  apiVersion: "3.0.0",
  permissions: {
    tier: "scoped",
    fs: {
      read: ["~/.kaizen/harnesses/**", "./.kaizen/harnesses/**"],
      write: ["~/.kaizen/harnesses/**", "./.kaizen/harnesses/**"],
    },
  },
  services: {
    provides: ["config:store"],
    consumes: ["slash:registry"],
  },
  async setup(_ctx) {
    // Implemented in Task 8 (wiring) after all pure modules land.
  },
};

export default plugin;
