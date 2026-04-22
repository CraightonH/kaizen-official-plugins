import type { KaizenPlugin } from "kaizen/types";
import { createLLMRuntime } from "kaizen/types";

const plugin: KaizenPlugin = {
  name: "core-executor-anthropic",
  apiVersion: "2.0.0",
  capabilities: { provides: ["core-driver:executor.send"] },

  permissions: {
    tier: "scoped",
    net: { connect: ["api.anthropic.com:443"] },
    env: ["ANTHROPIC_API_KEY"],
  },

  config: {
    schema: {
      properties: {
        model: { type: "string" },
        baseURL: { type: "string" },
        api_key: { type: "string" },
      },
      required: ["model"],
    },
    defaults: { model: "claude-opus-4-6" },
    secrets: ["api_key"],
  },

  async setup(ctx) {
    const model = ctx.config["model"] as string;
    if (!model) throw new Error("core-executor-anthropic: config.model is required");
    const apiKey = await ctx.secrets.get("api_key");
    const baseURL = ctx.config["baseURL"] as string | undefined;

    const executor = createLLMRuntime({
      adapter: "anthropic",
      model,
      ...(apiKey !== undefined ? { api_key: apiKey } : {}),
      ...(baseURL !== undefined ? { baseURL } : {}),
    });
    ctx.registerExecutor(executor);
  },
};

export default plugin;
