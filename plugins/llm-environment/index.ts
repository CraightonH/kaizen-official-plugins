import type { KaizenPlugin, PluginContext } from "kaizen/types";
import type { SystemPromptService, SlashRegistryService, ToolsRegistryService } from "llm-contracts/public";
import { captureEnvironment } from "./environment.ts";
import { makeEnvSlashHandlers } from "./slash.ts";
import { makeEnvToolHandlers } from "./tool.ts";

function safeUseService<T>(ctx: PluginContext, name: string): T | undefined {
  try {
    return ctx.useService<T>(name);
  } catch {
    return undefined;
  }
}

type RuntimeHints = { cwd?: string; env?: Record<string, string | undefined> };

let teardown: Array<() => void> = [];

const plugin = {
  name: "llm-environment",
  apiVersion: "3.0.0",
  permissions: { tier: "unscoped" },
  services: {
    provides: [],
    // Dependency classification (see docs/PLUGIN_ARCHITECTURE.md):
    //   prompt:registry — hard: section registration is the entire point of the plugin
    //   slash:registry / tools:registry — topo-hint optional: best-effort registration,
    //     listed here so kaizen schedules the providers before this plugin's setup.
    consumes: ["prompt:registry", "slash:registry", "tools:registry"],
  },

  async setup(ctx) {
    const runtime = ctx as PluginContext & RuntimeHints;
    const cwd = typeof runtime.cwd === "string" && runtime.cwd.length > 0 ? runtime.cwd : process.cwd();
    const env = runtime.env ?? process.env;

    const handle = captureEnvironment({ cwd, env });
    await handle.refresh();

    // Hard dependency — kaizen must refuse to boot this plugin if absent.
    ctx.consumeService("prompt:registry");
    const prompt = ctx.useService<SystemPromptService>("prompt:registry");
    const sectionHandle = prompt.register(handle.section);
    teardown.push(() => sectionHandle.unregister());

    const refresh = async (): Promise<void> => {
      await handle.refresh();
      sectionHandle.bumpGeneration();
    };

    const slashRegistry = safeUseService<SlashRegistryService>(ctx, "slash:registry");
    if (slashRegistry) {
      const { refresh: slashRefresh } = makeEnvSlashHandlers({ refresh });
      const unregister = slashRegistry.register(
        { name: slashRefresh.name, description: slashRefresh.description, source: "plugin" },
        slashRefresh.handler as never,
      );
      if (typeof unregister === "function") teardown.push(unregister);
    } else {
      ctx.log("[llm-environment] slash:registry not available; /env:refresh not registered");
    }

    const tools = safeUseService<ToolsRegistryService>(ctx, "tools:registry");
    if (tools) {
      const { refresh: toolRefresh } = makeEnvToolHandlers({ refresh });
      const unregister = tools.registerWith({
        schema: toolRefresh.schema,
        handler: toolRefresh.handler,
        source: { kind: "local" },
      });
      teardown.push(unregister);
    } else {
      ctx.log("[llm-environment] tools:registry not available; environment_refresh not registered");
    }
  },

  async stop(_ctx?: unknown) {
    const handles = teardown;
    teardown = [];
    for (const fn of handles) {
      try { fn(); } catch { /* idempotent */ }
    }
  },
} satisfies KaizenPlugin;

export default plugin;
