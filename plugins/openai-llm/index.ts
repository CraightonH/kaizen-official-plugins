import type { KaizenPlugin } from "kaizen/types";
import type { LLMCompleteService } from "llm-events/public";
import { loadConfig, realDeps } from "./config.ts";
import { makeService } from "./service.ts";

const VERSION = "0.1.0"; // keep in sync with package.json on release

const plugin: KaizenPlugin = {
  name: "openai-llm",
  apiVersion: "3.0.0",
  permissions: { tier: "trusted" },
  services: { provides: ["llm:complete"] },

  async setup(ctx) {
    const config = await loadConfig(realDeps((m) => ctx.log(m)));
    ctx.defineService("llm:complete", { description: "OpenAI-compatible chat completion provider." });
    ctx.provideService<LLMCompleteService>("llm:complete", makeService(config, { log: (m) => ctx.log(m) }, { fetch, version: VERSION }));
  },
};

export default plugin;
