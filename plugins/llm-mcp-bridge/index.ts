import type { KaizenPlugin } from "kaizen/types";

const plugin: KaizenPlugin = {
  name: "llm-mcp-bridge",
  apiVersion: "3.0.0",
  permissions: { tier: "unscoped" },
  services: { provides: ["mcp:bridge"], consumes: ["tools:registry", "llm-events:vocabulary"] },
  async setup(ctx) {
    // Filled in by Task 11.
    ctx.defineService("mcp:bridge", { description: "Owns MCP server lifecycles; surfaces their tools and resources." });
  },
};

export default plugin;
