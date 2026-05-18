import type { KaizenPlugin } from "kaizen/types";
import type { ConfigStoreService, LLMCompleteService } from "llm-contracts/public";
import { DEFAULT_CONFIG } from "./defaults.ts";
import type { OpenAILLMConfig } from "./public.d.ts";
import { makeService } from "./service.ts";

const VERSION = "0.1.1"; // keep in sync with package.json on release

const plugin: KaizenPlugin = {
  name: "openai-llm",
  apiVersion: "3.0.0",
  permissions: { tier: "unscoped" },
  services: { provides: ["llm:complete"], consumes: ["events:vocabulary", "config:store"] },

  async setup(ctx) {
    ctx.consumeService("events:vocabulary");
    ctx.consumeService("config:store");
    const config = ctx.useService<ConfigStoreService>("config:store");
    config.register<OpenAILLMConfig>({
      plugin: "openai-llm",
      defaults: {
        ...DEFAULT_CONFIG,
        retry: { ...DEFAULT_CONFIG.retry },
        extraHeaders: { ...DEFAULT_CONFIG.extraHeaders },
      },
      schema: {
        baseUrl: { type: "string", min: 1 },
        apiKey: { type: "string" },
        defaultModel: { type: "string", min: 1 },
        defaultTemperature: { type: "number" },
        requestTimeoutMs: { type: "number", min: 1 },
        connectTimeoutMs: { type: "number", min: 1 },
        retry: {
          type: "object",
          properties: {
            maxAttempts: { type: "number", integer: true, min: 1 },
            initialDelayMs: { type: "number", min: 0 },
            maxDelayMs: { type: "number", min: 0 },
            jitter: { type: "enum", values: ["full", "none"] },
          },
        },
        extraHeaders: { type: "object", properties: {}, additionalProperties: { type: "string" } },
      },
      envVars: { apiKey: "OPENAI_API_KEY" },
    });
    const cfg = config.get<OpenAILLMConfig>("openai-llm");
    ctx.provideService<LLMCompleteService>("llm:complete", makeService(cfg, { log: (m) => ctx.log(m) }, { fetch, version: VERSION }));
  },
};

export default plugin;
