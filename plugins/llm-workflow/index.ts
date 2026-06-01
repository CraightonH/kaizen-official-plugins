import type { KaizenPlugin } from "kaizen/types";
import type {
  WorkflowRegistryService, DriverService, AgentsRegistryService,
  ToolsRegistryService, SlashRegistryService, SystemPromptService,
  ConfigStoreService,
} from "llm-contracts/public";
import type { WorkflowConfigFile } from "./public.d.ts";
import { DEFAULT_CONFIG, CONFIG_SCHEMA } from "./config.ts";
import { makeRegistry, makeRegistryHandle } from "./registry.ts";
import { loadFromDirs } from "./loader.ts";
import { makeRunner } from "./runner.ts";
import { makeEngine } from "./engine.ts";
import { makeWorkflowTool } from "./tool.ts";
import { makeSlashHandlers } from "./slash.ts";
import { wireStatusItem, buildWorkflowsBlock } from "./status.ts";
import { homedir, cpus } from "node:os";
import { readdir, stat as fsStat, realpath as fsRealpath, readFile as fsReadFile } from "node:fs/promises";

let toolUnregister: (() => void) | undefined;
let slashOffs: Array<() => void> = [];
let sectionHandle: { bumpGeneration(): void; unregister(): void } | undefined;

function resolveDir(p: string, home: string, cwd: string): string {
  if (p.startsWith("~/")) return `${home}/${p.slice(2)}`;
  if (p === "~") return home;
  if (p.startsWith("/")) return p;
  return `${cwd}/${p}`;
}

const plugin: KaizenPlugin = {
  name: "llm-workflow",
  apiVersion: "3.0.0",
  permissions: { tier: "unscoped" },
  services: {
    provides: ["workflow:registry"],
    consumes: [
      "events:vocabulary",
      "driver:run-conversation",
      "tools:registry",
      "slash:registry",
      "agents:registry",
      "prompt:registry",
      "config:store",
    ],
  },

  async setup(ctx) {
    ctx.consumeService("events:vocabulary");
    const log = (m: string) => ctx.log(m);

    // Load config.
    let cfg: WorkflowConfigFile = { ...DEFAULT_CONFIG };
    const cfgSvc = ctx.useService<ConfigStoreService>("config:store");
    if (cfgSvc) {
      try {
        cfgSvc.register<WorkflowConfigFile>({
          plugin: "llm-workflow",
          defaults: { ...DEFAULT_CONFIG },
          schema: CONFIG_SCHEMA as any,
        });
        cfg = cfgSvc.get<WorkflowConfigFile>("llm-workflow");
      } catch (e) { log(`llm-workflow: config:store register failed (${(e as Error).message}); using defaults`); }
    } else {
      log("llm-workflow: config:store unavailable; using DEFAULT_CONFIG");
    }

    const home = homedir();
    const cwd = process.cwd();
    const userDir = resolveDir(cfg.userDir, home, cwd);
    const projectDir = resolveDir(cfg.projectDir, home, cwd);

    // Registry: start empty, swap in after discovery.
    const handle = makeRegistryHandle(makeRegistry([]));
    let ready = false;
    ctx.provideService<WorkflowRegistryService>("workflow:registry", {
      list: () => handle.service.list(),
      get: (n) => handle.service.get(n),
      register: (m) => handle.service.register(m),
      runInline: (s, o) => engine.runInline(s, o),
      runByName: (n, o) => engine.runByName(n, o),
    });

    // Status item wiring (events-only — no ui:status dep needed).
    wireStatusItem({ on: ctx.on, emit: (e, p) => { void ctx.emit(e, p); } });

    // Engine + runner.
    const driver = ctx.useService<DriverService>("driver:run-conversation");
    if (!driver) {
      void ctx.emit("harness:error", { message: "llm-workflow: driver:run-conversation unavailable; Workflow tool disabled" });
      return;
    }
    const agentsRegistry = ctx.useService<AgentsRegistryService>("agents:registry");
    const cpuCount = cpus().length;
    const runner = makeRunner({
      driver,
      agentsRegistry,
      emit: (e, p) => { void ctx.emit(e, p); },
      runByName: async (n, opts) => engine.runByName(n, opts),
      timeoutMs: cfg.timeoutMs,
      gracefulShutdownMs: cfg.workerGracefulShutdownMs,
      maxConcurrency: cfg.maxConcurrency ?? (Math.min(16, Math.max(1, cpuCount - 2))),
      maxLifetimeAgents: cfg.maxLifetimeAgents,
      sessionIdProvider: () => `workflow:${Date.now().toString(36)}`,
    });
    const engine = makeEngine({ registry: handle, runner, isReady: () => ready });

    // Workflow tool.
    const tools = ctx.useService<ToolsRegistryService>("tools:registry");
    if (tools) {
      const { schema, handler } = makeWorkflowTool({ engine });
      toolUnregister = tools.registerWith({ schema, handler, source: { kind: "local" } });
    } else {
      void ctx.emit("harness:error", { message: "llm-workflow: tools:registry unavailable; Workflow tool not registered" });
    }

    // Slash commands.
    try {
      const slash = ctx.useService<SlashRegistryService>("slash:registry");
      const { listHandler, getHandler, runHandler } = makeSlashHandlers({ engine });
      slashOffs.push(slash.register({ name: "workflows:list", description: "List registered workflows.", source: "plugin" }, listHandler));
      slashOffs.push(slash.register({ name: "workflows:get",  description: "Show one workflow's manifest and source.", usage: "<name>", source: "plugin" }, getHandler));
      slashOffs.push(slash.register({ name: "workflows:run",  description: "Run a named workflow with optional JSON args.", usage: "<name> [json-args]", source: "plugin" }, runHandler));
    } catch { /* slash:registry not defined in this harness — skip */ }

    // Prompt:registry section.
    const promptSystem = ctx.useService<SystemPromptService>("prompt:registry");
    if (promptSystem) {
      sectionHandle = promptSystem.register({
        id: "llm-workflow:available",
        priority: 140,
        title: "Available workflows",
        render: () => buildWorkflowsBlock(handle.service.list()),
      });
    }

    // Discovery in a microtask.
    queueMicrotask(async () => {
      try {
        const result = await loadFromDirs({
          userDir, projectDir,
          maxFileBytes: cfg.metaParse.maxFileBytes,
          deps: {
            readDir: (p) => readdir(p),
            stat: (p) => fsStat(p) as any,
            realpath: (p) => fsRealpath(p),
            readFile: (p) => fsReadFile(p, "utf8"),
          },
        });
        handle.setInner(makeRegistry(result.manifests, () => sectionHandle?.bumpGeneration()));
        ready = true;
        for (const e of result.errors) {
          await ctx.emit("harness:error", { message: `llm-workflow: ${e.path}: ${e.message}` });
        }
        sectionHandle?.bumpGeneration();
      } catch (err) {
        ready = true;
        await ctx.emit("harness:error", { message: `llm-workflow: discovery failed: ${(err as Error).message}` });
      }
    });
  },

  async stop() {
    try { toolUnregister?.(); } catch {} toolUnregister = undefined;
    try { sectionHandle?.unregister(); } catch {} sectionHandle = undefined;
    for (const off of slashOffs) { try { off(); } catch {} }
    slashOffs = [];
  },
};

export default plugin;
