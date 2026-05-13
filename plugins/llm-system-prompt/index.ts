import { homedir } from "node:os";
import { join } from "node:path";
import type { KaizenPlugin, PluginContext } from "kaizen/types";
import { createRegistry, type SystemPromptServiceImpl } from "./registry.ts";
import { resolveIdentity } from "./identity.ts";
import { makePromptSlashHandlers } from "./slash.ts";
import type { SystemPromptService } from "./public";
import type { SlashRegistryService } from "llm-slash-commands/public";

interface PromptEventVocabulary {
  PROMPT_REBUILT: string;
  PROMPT_RELOAD: string;
}

type RuntimeHints = {
  env?: Record<string, string | undefined>;
  cwd?: string;
};

function readEnv(ctx: RuntimeHints, key: string): string | undefined {
  const fromCtx = ctx.env?.[key];
  if (typeof fromCtx === "string" && fromCtx.length > 0) return fromCtx;
  const fromProc = process.env[key];
  return fromProc && fromProc.length > 0 ? fromProc : undefined;
}

function resolveGlobalPath(ctx: RuntimeHints): string {
  const override = readEnv(ctx, "KAIZEN_SYSTEM_PROMPT_GLOBAL");
  if (override !== undefined) return override;
  const home = readEnv(ctx, "HOME") ?? homedir();
  return join(home, ".kaizen", "system-prompt.md");
}

function resolveProjectPath(ctx: RuntimeHints): string {
  const override = readEnv(ctx, "KAIZEN_SYSTEM_PROMPT_PROJECT");
  if (override !== undefined) return override;
  const cwd = typeof ctx.cwd === "string" && ctx.cwd.length > 0 ? ctx.cwd : process.cwd();
  return join(cwd, ".kaizen", "system-prompt.md");
}

function safeUseService<T>(ctx: PluginContext, name: string): T | undefined {
  try {
    return ctx.useService<T>(name);
  } catch {
    return undefined;
  }
}

const plugin: KaizenPlugin = {
  name: "llm-system-prompt",
  apiVersion: "3.0.0",
  permissions: { tier: "unscoped" },
  services: {
    provides: ["prompt:system"],
    consumes: ["events:vocabulary"],
  },

  async setup(ctx) {
    const runtime = ctx as PluginContext & RuntimeHints;
    ctx.consumeService("events:vocabulary");
    const vocab = ctx.useService<PromptEventVocabulary>("events:vocabulary");
    // prompt:rebuilt / prompt:reload are defined by llm-events (canonical VOCAB owner).

    const registry: SystemPromptServiceImpl = createRegistry({
      events: { promptRebuilt: vocab.PROMPT_REBUILT },
      emit: async (event, payload) => {
        await ctx.emit(event, payload);
      },
    });

    ctx.defineService("prompt:system", {
      description: "Assembles the assistant's system prompt from registered sections.",
    });
    ctx.provideService<SystemPromptService>("prompt:system", registry);

    const identity = resolveIdentity({
      globalPath: resolveGlobalPath(runtime),
      projectPath: resolveProjectPath(runtime),
      env: runtime.env ?? process.env,
    });
    await identity.reload();
    const identityHandle = registry.register(identity.section);

    const slashRegistry = safeUseService<SlashRegistryService>(ctx, "slash:registry");
    if (slashRegistry) {
      const handlers = makePromptSlashHandlers({
        registry,
        reloadIdentity: async () => {
          await identity.reload();
          identityHandle.bumpGeneration();
          await ctx.emit(vocab.PROMPT_RELOAD, {});
        },
      });
      slashRegistry.register(
        { name: "prompt:show", description: "Show the current assembled system prompt.", usage: "[--stats]", source: "plugin" },
        handlers.show,
      );
      slashRegistry.register(
        { name: "prompt:reload", description: "Re-read identity files from disk.", source: "plugin" },
        handlers.reload,
      );
      slashRegistry.register(
        { name: "prompt:disable", description: "Disable a section by id (diagnostic).", usage: "<id>", source: "plugin" },
        handlers.disable,
      );
      slashRegistry.register(
        { name: "prompt:enable", description: "Enable a previously-disabled section.", usage: "<id>", source: "plugin" },
        handlers.enable,
      );
    }
  },
};

export default plugin;
