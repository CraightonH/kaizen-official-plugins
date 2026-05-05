import { homedir } from "node:os";
import { join } from "node:path";
import type { KaizenPlugin } from "kaizen/types";
import { createRegistry, type SystemPromptServiceImpl } from "./registry.ts";
import { resolveIdentity } from "./identity.ts";
import { makePromptSlashHandlers } from "./slash.ts";
import type { SystemPromptService } from "./public";

function readEnv(ctx: any, key: string): string | undefined {
  const fromCtx = ctx.env && typeof ctx.env === "object" ? (ctx.env as any)[key] : undefined;
  if (typeof fromCtx === "string" && fromCtx.length > 0) return fromCtx;
  const fromProc = process.env[key];
  return fromProc && fromProc.length > 0 ? fromProc : undefined;
}

function resolveGlobalPath(ctx: any): string {
  const override = readEnv(ctx, "KAIZEN_SYSTEM_PROMPT_GLOBAL");
  if (override !== undefined) return override;
  const home = readEnv(ctx, "HOME") ?? homedir();
  return join(home, ".kaizen", "system-prompt.md");
}

function resolveProjectPath(ctx: any): string {
  const override = readEnv(ctx, "KAIZEN_SYSTEM_PROMPT_PROJECT");
  if (override !== undefined) return override;
  const cwd = typeof ctx.cwd === "string" && ctx.cwd.length > 0 ? ctx.cwd : process.cwd();
  return join(cwd, ".kaizen", "system-prompt.md");
}

const plugin: KaizenPlugin = {
  name: "llm-system-prompt",
  apiVersion: "3.0.0",
  permissions: { tier: "trusted" },
  services: {
    provides: ["prompt:system"],
    consumes: ["slash:registry"],
  },

  async setup(ctx) {
    ctx.consumeService("slash:registry");
    // prompt:rebuilt / prompt:reload are defined by llm-events (canonical VOCAB owner).

    const registry: SystemPromptServiceImpl = createRegistry({
      emit: (event, payload) => ctx.emit(event, payload),
    });

    ctx.defineService("prompt:system", {
      description: "Assembles the assistant's system prompt from registered sections.",
    });
    ctx.provideService<SystemPromptService>("prompt:system", registry);

    const identity = resolveIdentity({
      globalPath: resolveGlobalPath(ctx),
      projectPath: resolveProjectPath(ctx),
      env: (ctx.env ?? process.env) as Record<string, string | undefined>,
    });
    await identity.reload();
    const identityHandle = registry.register(identity.section);

    const slashRegistry = ctx.useService?.("slash:registry") as
      | { register(m: { name: string; description: string; usage?: string; source: "plugin" }, h: any): () => void }
      | undefined;
    if (slashRegistry) {
      const handlers = makePromptSlashHandlers({
        registry,
        reloadIdentity: async () => {
          await identity.reload();
          identityHandle.bumpGeneration();
          await ctx.emit("prompt:reload", {});
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
