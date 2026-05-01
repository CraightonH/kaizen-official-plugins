import type { KaizenPlugin } from "kaizen/types";

const plugin: KaizenPlugin = {
  name: "llm-hooks-shell",
  apiVersion: "3.0.0",
  permissions: { tier: "unscoped", exec: { binaries: ["sh"] } },
  services: { consumes: ["llm-events:vocabulary"] },
  async setup(ctx) {
    // Filled in by Task H6.
    ctx.consumeService("llm-events:vocabulary");
  },
};

export default plugin;
