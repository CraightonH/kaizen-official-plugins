import type { KaizenPlugin } from "kaizen/types";
import type { AgentsRegistryService } from "./public";
import type { ToolsRegistryService } from "llm-tools-registry/public";
import type { DriverService } from "llm-driver/public";
import type { SessionsStoreService } from "llm-contracts/public";
import type { SystemPromptService } from "llm-system-prompt/public";
import { loadConfig, realDeps } from "./config.ts";
import { loadFromDirs } from "./loader.ts";
import { makeRegistry, makeRegistryHandle } from "./registry.ts";
import { makeTurnTracker } from "./turn-tracker.ts";
import { makeInjector, buildAgentsBlock } from "./injector.ts";
import { makeDispatchTool } from "./dispatch.ts";
import { readdir, stat as fsStat, realpath as fsRealpath, readFile as fsReadFile } from "node:fs/promises";

// Module-scope handles for idempotent stop() cleanup. Reset every setup().
let sectionHandle: { bumpGeneration(): void; unregister(): void } | undefined;
let toolUnregister: (() => void) | undefined;

const plugin: KaizenPlugin = {
  name: "llm-agents",
  apiVersion: "3.0.0",
  permissions: { tier: "unscoped" },
  services: {
    provides: ["agents:registry"],
    // Narrow consumes: only the foundation vocabulary is a hard requirement.
    // All other integrations (tools:registry, driver:run-conversation,
    // sessions:store, prompt:system, skills:registry) are looked up via
    // useService and degrade with a harness:error when absent.
    consumes: ["events:vocabulary"],
  },

  async setup(ctx) {
    const log = (m: string) => ctx.log(m);
    const config = await loadConfig(realDeps(log));

    // bumpGeneration callback — closure-captured so both the initial empty
    // registry and the post-discovery registry can call it without knowing
    // about prompt:system.
    const bumpSection = () => sectionHandle?.bumpGeneration();

    // Create a handle that wraps an initially-empty registry. After
    // discovery completes, we call handle.setInner(newRegistry). The initial
    // registry is built with bumpSection so synthetic agents registered
    // before discovery still trigger a re-render.
    const handle = makeRegistryHandle(makeRegistry([], bumpSection));

    let ready = false;

    ctx.defineService("agents:registry", { description: "Agent manifest registry." });
    ctx.provideService<AgentsRegistryService>("agents:registry", handle.service);

    const tracker = makeTurnTracker();
    makeInjector({ ctx: { on: ctx.on, log }, registry: handle, tracker });

    const tools = ctx.useService<ToolsRegistryService>("tools:registry");
    const driver = ctx.useService<DriverService>("driver:run-conversation");
    const sessions = ctx.useService<SessionsStoreService>("sessions:store");

    if (!tools || !driver || !sessions) {
      const missing = [
        !tools && "tools:registry",
        !driver && "driver:run-conversation",
        !sessions && "sessions:store",
      ].filter(Boolean).join(", ");
      void ctx.emit("harness:error", { message: `llm-agents: missing required service(s): ${missing}; dispatch_agent disabled` });
    } else {
      const dispatch = makeDispatchTool({
        registry: handle,
        tracker,
        driver,
        sessions,
        maxDepth: config.maxDepth,
        hasSkills: () => !!ctx.useService("skills:registry"),
        emit: async (event, payload) => { await ctx.emit(event, payload); },
      });
      const realHandler = dispatch.handler;
      const guardedHandler: typeof realHandler = async (args, tCtx) => {
        if (!ready) throw new Error("Agent registry still loading; retry");
        return realHandler(args, tCtx);
      };
      toolUnregister = tools.registerWith({ schema: dispatch.schema, handler: guardedHandler, source: { kind: "agent" } });
    }

    // Register prompt:system section for available agents.
    const promptSystem = ctx.useService<SystemPromptService>("prompt:system");
    if (promptSystem) {
      sectionHandle = promptSystem.register({
        id: "llm-agents:available",
        priority: 150,
        title: "Available agents",
        render: () => buildAgentsBlock(handle.service.list()),
      });
    } else {
      void ctx.emit("harness:error", { message: "llm-agents: missing optional service prompt:system; available-agents section disabled" });
    }

    // Discovery in a microtask — does not block setup().
    queueMicrotask(async () => {
      try {
        const result = await loadFromDirs({
          userDir: config.resolvedUserDir,
          projectDir: config.resolvedProjectDir,
          deps: {
            readDir: (p) => readdir(p),
            stat: (p) => fsStat(p) as any,
            realpath: (p) => fsRealpath(p),
            readFile: (p) => fsReadFile(p, "utf8"),
          },
        });
        handle.setInner(makeRegistry(result.manifests, bumpSection), bumpSection);
        ready = true;
        for (const e of result.errors) {
          await ctx.emit("harness:error", { message: `llm-agents: ${e.path}: ${e.message}` });
        }
      } catch (err) {
        ready = true;
        await ctx.emit("harness:error", { message: `llm-agents: discovery failed: ${(err as Error).message}` });
      }
    });
  },

  async stop() {
    // Idempotent cleanup on reload. The registry handle is intentionally not
    // torn down — its in-memory state is rebuilt by the next setup() call.
    try { toolUnregister?.(); } catch { /* ignore */ }
    toolUnregister = undefined;
    try { sectionHandle?.unregister(); } catch { /* ignore */ }
    sectionHandle = undefined;
  },
};

export default plugin;
