import type { KaizenPlugin } from "kaizen/types";

const plugin: KaizenPlugin = {
  name: "llm-tui",
  apiVersion: "3.0.0",
  permissions: { tier: "trusted" },
  services: {
    provides: ["llm-tui:channel", "llm-tui:completion", "llm-tui:status", "llm-tui:theme"],
    consumes: ["llm-events:vocabulary"],
  },
  async setup(ctx) {
    // Filled in by Task 11.
    ctx.consumeService("llm-events:vocabulary");
    ctx.defineService("llm-tui:channel", { description: "Chat I/O channel." });
    ctx.defineService("llm-tui:completion", { description: "Completion source registry." });
    ctx.defineService("llm-tui:status", { description: "Status bar marker service." });
    ctx.defineService("llm-tui:theme", { description: "Read-only theme tokens." });
  },
};

export default plugin;
