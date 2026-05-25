import { makePromptToolHandlers } from "./tool.ts";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { KaizenPlugin, PluginContext } from "kaizen/types";
import { createRegistry, type SystemPromptServiceImpl } from "./registry.ts";
import { resolveIdentity } from "./identity.ts";
import { makePromptSlashHandlers } from "./slash.ts";
import type {
  ConfigStoreService,
  SystemPromptService,
  SlashRegistryService,
  ToolsRegistryService,
} from "llm-contracts/public";
import type { LlmSystemPromptConfig } from "./public.d.ts";
import { DEFAULT_CONFIG, CONFIG_SCHEMA } from "./config.ts";

interface PromptEventVocabulary {
  PROMPT_REBUILT: string;
  PROMPT_RELOAD: string;
}

type RuntimeHints = {
  env?: Record<string, string | undefined>;
  cwd?: string;
};

function expandTilde(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

function resolveGlobalPath(runtime: RuntimeHints, configured: string): string {
  const home =
    (typeof runtime.env?.HOME === "string" && runtime.env.HOME.length > 0
      ? runtime.env.HOME
      : undefined) ?? homedir();
  const expanded = expandTilde(configured, home);
  if (isAbsolute(expanded)) return expanded;
  const cwd =
    typeof runtime.cwd === "string" && runtime.cwd.length > 0
      ? runtime.cwd
      : process.cwd();
  return join(cwd, expanded);
}

function resolveProjectPath(runtime: RuntimeHints, configured: string): string {
  const home =
    (typeof runtime.env?.HOME === "string" && runtime.env.HOME.length > 0
      ? runtime.env.HOME
      : undefined) ?? homedir();
  const expanded = expandTilde(configured, home);
  if (isAbsolute(expanded)) return expanded;
  const cwd =
    typeof runtime.cwd === "string" && runtime.cwd.length > 0
      ? runtime.cwd
      : process.cwd();
  return join(cwd, expanded);
}

function safeUseService<T>(ctx: PluginContext, name: string): T | undefined {
  try {
    return ctx.useService<T>(name);
  } catch {
    return undefined;
  }
}

// Module-scope cleanup handles. setup() populates these; stop() drains them.
let identityHandle: ReturnType<NonNullable<SystemPromptService["register"]>> | undefined;
let toolUnregisters: Array<() => void> = [];

const plugin: KaizenPlugin = {
  name: "llm-system-prompt",
  apiVersion: "3.0.0",
  permissions: { tier: "unscoped" },
  services: {
    provides: ["prompt:registry"],
    consumes: ["events:vocabulary", "config:store", "tools:registry"],
  },

  async setup(ctx) {
    const runtime = ctx as PluginContext & RuntimeHints;
    const log = (m: string) => ctx.log?.(m);
    ctx.consumeService("events:vocabulary");
    const vocab = ctx.useService<PromptEventVocabulary>("events:vocabulary");
    // prompt:rebuilt / prompt:reload are defined by llm-events (canonical VOCAB owner).

    // Load config (topo-hint optional).
    let config: LlmSystemPromptConfig = { ...DEFAULT_CONFIG };
    const cfgSvc = safeUseService<ConfigStoreService>(ctx, "config:store");
    if (cfgSvc) {
      try {
        cfgSvc.register<LlmSystemPromptConfig>({
          plugin: "llm-system-prompt",
          defaults: { ...DEFAULT_CONFIG },
          schema: CONFIG_SCHEMA,
        });
        config = cfgSvc.get<LlmSystemPromptConfig>("llm-system-prompt");
      } catch (e) {
        log(
          `llm-system-prompt: config:store register failed (${(e as Error).message}); using defaults`,
        );
      }
    } else {
      log("llm-system-prompt: config:store unavailable; using DEFAULT_CONFIG");
    }

    const registry: SystemPromptServiceImpl = createRegistry({
      events: { promptRebuilt: vocab.PROMPT_REBUILT },
      emit: async (event, payload) => {
        await ctx.emit(event, payload);
      },
    });

    ctx.provideService<SystemPromptService>("prompt:registry", registry);

    const identity = resolveIdentity({
      globalPath: resolveGlobalPath(runtime, config.globalPath),
      projectPath: resolveProjectPath(runtime, config.projectPath),
      enabled: config.enabled,
      projectHeader: config.projectHeader,
      fallbackPrefix: config.fallbackPrefix,
    });
    await identity.reload();
    identityHandle = registry.register(identity.section);

    const reloadIdentity = async () => {
      await identity.reload();
      identityHandle!.bumpGeneration();
      await ctx.emit(vocab.PROMPT_RELOAD, {});
    };

    const slashRegistry = safeUseService<SlashRegistryService>(ctx, "slash:registry");
    if (slashRegistry) {
      const handlers = makePromptSlashHandlers({
        registry,
        reloadIdentity,
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

    // Register prompt_* tools into tools:registry if available.
    const toolsRegistry = safeUseService<ToolsRegistryService>(ctx, "tools:registry");
    if (toolsRegistry) {
      const tools = makePromptToolHandlers({ registry, reloadIdentity });
      for (const entry of [tools.show, tools.reload, tools.disable, tools.enable]) {
        toolUnregisters.push(
          toolsRegistry.registerWith({
            schema: entry.schema,
            handler: entry.handler,
            source: { kind: "prompt" },
          }),
        );
      }
    } else {
      ctx.log?.("[llm-system-prompt] tools:registry not available; prompt_* tools not registered");
    }
  },

  async stop() {
    for (const u of toolUnregisters) {
      try { u(); } catch { /* idempotent */ }
    }
    toolUnregisters = [];
    try { identityHandle?.unregister(); } catch { /* idempotent */ }
    identityHandle = undefined;
  },
};

export default plugin;
