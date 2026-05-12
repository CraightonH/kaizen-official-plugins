import type { KaizenPlugin } from "kaizen/types";
import type { LLMCompleteService } from "llm-events/public";
import { loadConfig, realDeps } from "./config.ts";
import { makeService } from "./service.ts";

const VERSION = "0.1.0"; // keep in sync with package.json on release

const plugin: KaizenPlugin = {
  name: "openai-llm",
  apiVersion: "3.0.0",
  permissions: { tier: "unscoped" },
  services: { provides: ["llm:complete"], consumes: ["llm-events:vocabulary"] },

  async setup(ctx) {
    ctx.consumeService("llm-events:vocabulary");
    const config = await loadConfig(realDeps((m) => ctx.log(m)));
    ctx.provideService<LLMCompleteService>("llm:complete", makeService(config, { log: (m) => ctx.log(m) }, { fetch, version: VERSION }));
  },
};

export default plugin;
