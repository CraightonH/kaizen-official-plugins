import type { KaizenPlugin } from "kaizen/types";

const plugin: KaizenPlugin = {
  name: "llm-driver",
  apiVersion: "3.0.0",
  driver: true,
  permissions: { tier: "unscoped" },
  services: {
    consumes: [
      "llm-events:vocabulary",
      "claude-tui:channel",
      "llm:complete",
      "tools:registry",
      "tool-dispatch:strategy",
    ],
    provides: ["driver:run-conversation"],
  },
  async setup(ctx) {
    // Filled in by Task 9.
    ctx.defineService("driver:run-conversation", {
      description: "Run a (possibly nested) conversation against the LLM with optional tool dispatch.",
    });
  },
};

export default plugin;
