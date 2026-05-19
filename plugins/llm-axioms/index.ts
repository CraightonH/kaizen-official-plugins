import type { KaizenPlugin } from "kaizen/types";
import type {
  ConfigStoreService,
  SystemPromptService,
  RegisteredSection,
  AxiomsRegistryService,
} from "llm-contracts/public";
import { homedir } from "node:os";
import type { AxiomsConfig } from "./public.d.ts";
import { DEFAULT_CONFIG, CONFIG_SCHEMA } from "./config.ts";
import { resolveAxiomsDir, ensureDir, sweepStaleTempFiles } from "./paths.ts";
import { makeStore } from "./store.ts";
import { renderMethodology } from "./methodology.ts";
import { buildWorkspaceBlock } from "./injection.ts";
import { registerTools, type ToolsRegistryLike } from "./tools.ts";
import { registerSlashCommands, type SlashRegistryLike } from "./slash.ts";

let methodologyHandle: RegisteredSection | undefined;
let workspaceHandle: RegisteredSection | undefined;
let toolsUnregister: (() => void) | undefined;
let slashUnregister: Array<() => void> | undefined;

const plugin: KaizenPlugin = {
  name: "llm-axioms",
  apiVersion: "3.0.0",
  permissions: { tier: "unscoped" },
  services: {
    provides: ["axioms:registry"],
    consumes: [
      "events:vocabulary",
      "config:store",
      "prompt:registry",
      "tools:registry",
      "slash:registry",
    ],
  },

  async setup(ctx) {
    const log = (m: string) => ctx.log?.(m);

    // Load config (topo-hint optional).
    let config: AxiomsConfig = { ...DEFAULT_CONFIG };
    const cfgSvc = ctx.useService<ConfigStoreService>("config:store");
    if (cfgSvc) {
      try {
        cfgSvc.register<AxiomsConfig>({
          plugin: "llm-axioms",
          defaults: { ...DEFAULT_CONFIG },
          schema: CONFIG_SCHEMA,
        });
        config = cfgSvc.get<AxiomsConfig>("llm-axioms");
      } catch (e) {
        log(`llm-axioms: config:store register failed (${(e as Error).message}); using defaults`);
      }
    } else {
      log("llm-axioms: config:store unavailable; using DEFAULT_CONFIG");
    }

    const axiomsDir = resolveAxiomsDir({ home: homedir(), configured: config.axiomsDir });
    await ensureDir(axiomsDir);
    await sweepStaleTempFiles(axiomsDir, config.staleTempMs);

    const store = makeStore({ axiomsDir, log });
    ctx.provideService<AxiomsRegistryService>("axioms:registry", store);

    // Prompt sections — register before subscribing to session changes so
    // section.bumpGeneration is wired before any swap fires.
    const promptSystem = ctx.useService<SystemPromptService>("prompt:registry");
    if (promptSystem) {
      if (config.methodologyEnabled) {
        methodologyHandle = promptSystem.register({
          id: "llm-axioms:methodology",
          priority: 50,
          render: async () => renderMethodology(),
        });
      }
      if (config.workspaceEnabled) {
        workspaceHandle = promptSystem.register({
          id: "llm-axioms:workspace",
          priority: 180,
          render: async () => {
            const block = buildWorkspaceBlock(store.list(), config.injectionByteCap);
            return block ?? "";
          },
        });
        store.onChange(() => { workspaceHandle?.bumpGeneration(); });
      }
    } else {
      log("llm-axioms: prompt:registry unavailable; sections not registered");
    }

    // Tools.
    const tools = ctx.useService<ToolsRegistryLike>("tools:registry");
    if (tools) {
      toolsUnregister = registerTools(tools, store);
    } else {
      log("llm-axioms: tools:registry unavailable; tools not registered");
    }

    // Slash commands.
    const slash = ctx.useService<SlashRegistryLike>("slash:registry");
    if (slash) {
      slashUnregister = registerSlashCommands(slash, store);
    } else {
      log("llm-axioms: slash:registry unavailable; slash commands not registered");
    }

    // Session lifecycle.
    ctx.on("session:active-changed", async (payload: unknown) => {
      const sid = (payload as { sessionId?: string } | undefined)?.sessionId ?? null;
      await store.swapSession(sid);
    });
  },

  async stop() {
    try { toolsUnregister?.(); } catch { /* idempotent */ }
    try { for (const u of slashUnregister ?? []) u(); } catch { /* idempotent */ }
    try { workspaceHandle?.unregister(); } catch { /* idempotent */ }
    try { methodologyHandle?.unregister(); } catch { /* idempotent */ }
    toolsUnregister = undefined;
    slashUnregister = undefined;
    workspaceHandle = undefined;
    methodologyHandle = undefined;
  },
};

export default plugin;
