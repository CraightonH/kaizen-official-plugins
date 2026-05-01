import { homedir } from "node:os";
import type { KaizenPlugin } from "kaizen/types";
import type { LLMRequest } from "llm-events/public";
import { loadConfig, realDeps } from "./config.ts";
import { resolveDirs, ensureDir, sweepStaleTempFiles } from "./paths.ts";
import { makeMemoryStore } from "./service.ts";
import { buildMemoryBlock } from "./injection.ts";
import { registerTools } from "./tools.ts";
import { maybeExtract } from "./extract.ts";
import type { MemoryStoreService } from "./public.d.ts";

const plugin: KaizenPlugin = {
  name: "llm-memory",
  apiVersion: "3.0.0",
  permissions: { tier: "unscoped" },
  services: {
    provides: ["memory:store"],
    consumes: ["llm-events:vocabulary", "tools:registry", "driver:run-conversation"],
  },

  async setup(ctx) {
    const log = (m: string) => ctx.log(m);
    const config = await loadConfig(realDeps(log));
    const { globalDir, projectDir } = resolveDirs({
      home: homedir(),
      cwd: process.cwd(),
      config: { globalDir: config.globalDir, projectDir: config.projectDir },
    });

    await ensureDir(globalDir);
    if (projectDir) {
      // Project directory is created lazily on first put when the user opts in.
      // Sweep stale temp files only if it already exists.
    }
    await sweepStaleTempFiles(globalDir, config.staleTempMs);
    if (projectDir) await sweepStaleTempFiles(projectDir, config.staleTempMs);

    const store = makeMemoryStore({ globalDir, projectDir, log });
    ctx.defineService("memory:store", { description: "File-backed persistent memory store." });
    ctx.provideService<MemoryStoreService>("memory:store", store);

    // Injection hook: append a memory block to request.systemPrompt.
    ctx.on("llm:before-call", async (payload: { request: LLMRequest }) => {
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
      if (!block) return;
      const prev = payload.request.systemPrompt ?? "";
      payload.request.systemPrompt = prev.length === 0 ? block : `${prev}\n\n${block}`;
    });

    // Tools registration (best-effort; the tools registry may not exist in A-tier harnesses).
    const registry = ctx.useService<any>("tools:registry");
    if (registry) {
      registerTools(registry, store, { log, denyTypes: config.denyTypes });
    } else {
      log("llm-memory: tools:registry not available; memory_recall/memory_save not registered");
    }

    // Auto-extraction (off by default).
    if (config.autoExtract) {
      ctx.on("turn:end", async (payload: { reason: string; lastUserMessage?: string; turnId?: string }) => {
        if (!payload.lastUserMessage || !payload.turnId) return;
        const driver = ctx.useService<{ runConversation: any }>("driver:run-conversation");
        await maybeExtract(
          { reason: payload.reason, lastUserMessage: payload.lastUserMessage, turnId: payload.turnId },
          { config, runConversation: driver?.runConversation ?? null, log },
        );
      });
    }
  },
};

export default plugin;
