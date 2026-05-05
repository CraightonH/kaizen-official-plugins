import type { KaizenPlugin } from "kaizen/types";
import type { ToolDispatchStrategy } from "llm-events/public";
import { loadConfig, realDeps } from "./config.ts";
import { makeStrategy } from "./service.ts";
import { makeApiSurfaceSection } from "./section.ts";
import { prepareRequest } from "./prepare-request.ts";

const plugin: KaizenPlugin = {
  name: "llm-codemode-dispatch",
  apiVersion: "3.0.0",
  permissions: { tier: "unscoped" },
  services: { provides: ["tool-dispatch:strategy"] },

  async setup(ctx) {
    const config = await loadConfig(realDeps((m) => ctx.log(m)));

    let promptSystemSection:
      | { handle: { unregister(): void; bumpGeneration(): void }; detach: () => void }
      | undefined;

    const promptSystem = ctx.useService?.("prompt:system") as
      | { register(s: any): { unregister(): void; bumpGeneration(): void } }
      | undefined;
    const toolsRegistry = ctx.useService?.("tools:registry") as
      | { listRegistrations(): any[] }
      | undefined;

    if (promptSystem && toolsRegistry) {
      const wiring = makeApiSurfaceSection({
        registry: toolsRegistry as any,
        on: (event, h) => ctx.on(event, h),
      });
      const handle = promptSystem.register(wiring.section);
      const detach = wiring.attach(() => handle.bumpGeneration());
      promptSystemSection = { handle, detach };
    }

    ctx.defineService("tool-dispatch:strategy", {
      description: "Code-mode tool dispatch (LLM writes TS calling kaizen.tools.*).",
    });

    const baseStrategy = makeStrategy(config, { log: (m) => ctx.log(m) });
    const strategy: ToolDispatchStrategy = {
      ...baseStrategy,
      prepareRequest: (async ({ availableTools }: any) => {
        if (promptSystemSection) return {};
        return prepareRequest({ availableTools });
      }) as any,
    };

    ctx.provideService<ToolDispatchStrategy>("tool-dispatch:strategy", strategy);
  },
};

export default plugin;
