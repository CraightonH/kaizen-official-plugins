import type { KaizenPlugin } from "kaizen/types";
import type { ToolDispatchStrategy } from "llm-events/public";
import { loadConfig, realDeps } from "./config.ts";
import { makeStrategy } from "./service.ts";

const plugin: KaizenPlugin = {
  name: "llm-codemode-dispatch",
  apiVersion: "3.0.0",
  permissions: { tier: "unscoped" },
  services: { provides: ["tool-dispatch:strategy"] },

  async setup(ctx) {
    const config = await loadConfig(realDeps((m) => ctx.log(m)));
    ctx.defineService("tool-dispatch:strategy", {
      description: "Code-mode tool dispatch (LLM writes TS calling kaizen.tools.*).",
    });
    ctx.provideService<ToolDispatchStrategy>(
      "tool-dispatch:strategy",
      makeStrategy(config, { log: (m) => ctx.log(m) }),
    );
  },
};

export default plugin;
