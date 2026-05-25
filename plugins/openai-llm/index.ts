import type { KaizenPlugin } from "kaizen/types";
import type { ConfigStoreService, LLMCompleteService } from "llm-contracts/public";
import { DEFAULT_CONFIG, CONFIG_SCHEMA } from "./config.ts";
import type { OpenAILLMConfig } from "./public.d.ts";
import { makeService } from "./service.ts";

const VERSION = "0.1.1"; // keep in sync with package.json on release

const plugin: KaizenPlugin = {
  name: "openai-llm",
  apiVersion: "3.0.0",
  permissions: { tier: "unscoped" },
  services: { provides: ["llm:complete"], consumes: ["events:vocabulary", "config:store"] },

  async setup(ctx) {
    const log = (m: string) => ctx.log?.(m);

    // Load config (topo-hint optional). Deep-spread the nested objects so the
    // frozen DEFAULT_CONFIG isn't shared by reference with the store.
    let config: OpenAILLMConfig = {
      ...DEFAULT_CONFIG,
      retry: { ...DEFAULT_CONFIG.retry },
      extraHeaders: { ...DEFAULT_CONFIG.extraHeaders },
    };

    const cfgSvc = ctx.useService<ConfigStoreService>("config:store");
    if (cfgSvc) {
      try {
        cfgSvc.register<OpenAILLMConfig>({
          plugin: "openai-llm",
          defaults: {
            ...DEFAULT_CONFIG,
            retry: { ...DEFAULT_CONFIG.retry },
            extraHeaders: { ...DEFAULT_CONFIG.extraHeaders },
          },
          schema: CONFIG_SCHEMA,
        });
        // Await ready() so the secret-ref ($ref pointer) for apiKey is
        // resolved to plaintext before the first get(). Without this, the
        // service captures the {$ref} object for its lifetime.
        await cfgSvc.ready();
        config = cfgSvc.get<OpenAILLMConfig>("openai-llm");
      } catch (e) {
        log(`openai-llm: config:store register failed (${(e as Error).message}); using defaults`);
      }
    } else {
      log("openai-llm: config:store unavailable; using DEFAULT_CONFIG");
    }

    ctx.provideService<LLMCompleteService>(
      "llm:complete",
      makeService(config, { log: (m) => ctx.log(m) }, { fetch, version: VERSION }),
    );
  },
};

export default plugin;
