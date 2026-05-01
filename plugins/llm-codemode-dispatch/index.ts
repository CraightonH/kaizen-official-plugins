import type { KaizenPlugin } from "kaizen/types";
import type { ToolDispatchStrategy } from "llm-events/public";
import { makeStrategy } from "./service.ts";

const plugin: KaizenPlugin = {
  name: "llm-codemode-dispatch",
  apiVersion: "3.0.0",
  permissions: { tier: "unscoped" },
  services: { provides: ["tool-dispatch:strategy"] },

  async setup(ctx) {
    ctx.defineService("tool-dispatch:strategy", {
      description: "Code-mode tool dispatch strategy (LLM writes TS calling kaizen.tools.*).",
    });
    const strategy: ToolDispatchStrategy = makeStrategy({}, { log: (m) => ctx.log(m) });
    ctx.provideService<ToolDispatchStrategy>("tool-dispatch:strategy", strategy);
  },
};

export default plugin;
