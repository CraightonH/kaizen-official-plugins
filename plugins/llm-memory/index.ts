import type { KaizenPlugin } from "kaizen/types";
import type { SystemPromptService, RegisteredSection } from "llm-contracts/public";
import { loadConfig, realDeps } from "./config.ts";
import { resolveDirs, ensureDir, sweepStaleTempFiles } from "./paths.ts";
import { makeMemoryStore } from "./service.ts";
import { buildMemoryBlock } from "./injection.ts";
import { registerTools, type ToolsRegistryLike } from "./tools.ts";
import { maybeExtract, type RunConversationFn } from "./extract.ts";
import type { MemoryStoreService } from "llm-contracts/public";

let sectionHandle: RegisteredSection | undefined;
let toolsUnregister: (() => void) | undefined;

const plugin: KaizenPlugin = {
  name: "llm-memory",
  apiVersion: "3.0.0",
  permissions: { tier: "unscoped" },
  services: {
    provides: ["memory:store"],
    // No hard consume edges: all integrations (prompt:registry, tools:registry,
    // driver:run-conversation) are optional and degrade cleanly when absent.
    // events:vocabulary is not used directly by this plugin (events are emitted
    // with hardcoded names), so it is not listed here.
  },

  async setup(ctx) {
    const log = (m: string) => ctx.log(m);
    const config = await loadConfig(realDeps(log));
    const { globalDir, projectDir } = resolveDirs({
      home: process.env.HOME ?? "/",
      cwd: process.cwd(),
      config: { globalDir: config.globalDir, projectDir: config.projectDir },
    });

    await ensureDir(globalDir);
    // Project directory is created lazily on first put when the user opts in;
    // we only need to sweep stale temps if it already exists.
    await sweepStaleTempFiles(globalDir, config.staleTempMs);
    if (projectDir) await sweepStaleTempFiles(projectDir, config.staleTempMs);

    // Resolve prompt:registry before creating the store so onChange can bump generation.
    const promptSystem = ctx.useService<SystemPromptService>("prompt:registry");

    const store = makeMemoryStore({
      globalDir,
      projectDir,
      log,
      onChange: () => { sectionHandle?.bumpGeneration(); },
    });
    ctx.provideService<MemoryStoreService>("memory:store", store);

    // Register a prompt:system section for saved memories.
    //
    // Approach A: no `title` field — `buildMemoryBlock` returns a self-contained block
    // with its own `<system-reminder>` wrapper and `# Persistent memory` heading. Adding
    // a section title would produce redundant double headers. The render contract returns
    // `""` (not `null`) on empty so the registry drops the section cleanly for that call.
    if (promptSystem) {
      sectionHandle = promptSystem.register({
        id: "llm-memory:auto",
        priority: 170,
        render: async () => {
          const projectIdx = projectDir ? await store.readIndex("project") : "";
          const globalIdx = await store.readIndex("global");
          const denyTypes = new Set(config.denyTypes);
          const projectEntries = projectDir
            ? (await store.list({ scope: "project" })).filter((e) => !denyTypes.has(e.type))
            : [];
          const globalEntries = (await store.list({ scope: "global" })).filter((e) => !denyTypes.has(e.type));
          const block = buildMemoryBlock({
            projectIndex: projectIdx,
            globalIndex: globalIdx,
            projectEntries,
            globalEntries,
            projectPath: projectDir ?? "(disabled)",
            byteCap: config.injectionByteCap,
          });
          return block ?? "";
        },
      });
    } else {
      // prompt:system is an optional consume; without it the saved-memories section
      // simply cannot be injected. Emit a visible warning so harness operators notice
      // the degraded state.
      void ctx.emit("harness:error", {
        message:
          "llm-memory: prompt:registry service unavailable; saved-memories section disabled",
      });
    }

    // Tools registration (best-effort; tools:registry may not exist in A-tier harnesses).
    const registry = ctx.useService<ToolsRegistryLike>("tools:registry");
    if (registry) {
      const handle = registerTools(registry, store, { log, denyTypes: config.denyTypes });
      toolsUnregister = handle.unregister;
    } else {
      log("llm-memory: tools:registry not available; memory_recall/memory_save not registered");
    }

    // Auto-extraction (off by default).
    if (config.autoExtract) {
      ctx.on("turn:end", async (payload: unknown) => {
        const p = (payload ?? {}) as { reason?: string; lastUserMessage?: string; turnId?: string; sessionId?: string };
        if (!p.reason || !p.lastUserMessage || !p.turnId) return;
        const driver = ctx.useService<{ runConversation: RunConversationFn }>("driver:run-conversation");
        await maybeExtract(
          { reason: p.reason, lastUserMessage: p.lastUserMessage, turnId: p.turnId, sessionId: p.sessionId },
          { config, runConversation: driver?.runConversation ?? null, log },
        );
      });
    }
  },

  async stop() {
    try { toolsUnregister?.(); } catch { /* idempotent */ }
    try { sectionHandle?.unregister(); } catch { /* idempotent */ }
    toolsUnregister = undefined;
    sectionHandle = undefined;
  },
};

export default plugin;
