import type { KaizenPlugin } from "kaizen/types";
import type { AgentsRegistryService, DriverService, ToolsRegistryService } from "llm-events/public";
import { loadConfig, realDeps } from "./config.ts";
import { loadFromDirs } from "./loader.ts";
import { makeRegistry, makeRegistryHandle } from "./registry.ts";
import { makeTurnTracker } from "./turn-tracker.ts";
import { makeInjector } from "./injector.ts";
import { makeDispatchTool } from "./dispatch.ts";
import { readdir, stat as fsStat, realpath as fsRealpath, readFile as fsReadFile } from "node:fs/promises";

const plugin: KaizenPlugin = {
  name: "llm-agents",
  apiVersion: "3.0.0",
  permissions: { tier: "unscoped" },
  services: {
    provides: ["agents:registry"],
    consumes: ["tools:registry", "driver:run-conversation", "llm-events:vocabulary"],
  },

  async setup(ctx) {
    const log = (m: string) => ctx.log(m);
    const config = await loadConfig(realDeps(log));

    // Create a handle that wraps an initially-empty registry.
    // After discovery completes, we call handle.setInner(newRegistry).
    const handle = makeRegistryHandle(makeRegistry([]));
    let ready = false;

    ctx.defineService("agents:registry", { description: "Agent manifest registry." });
    ctx.provideService<AgentsRegistryService>("agents:registry", handle.service);

    const tracker = makeTurnTracker();
    makeInjector({ ctx: { on: ctx.on, log }, registry: handle, tracker });

    const tools = ctx.useService<ToolsRegistryService>("tools:registry");
    const driver = ctx.useService<DriverService>("driver:run-conversation");

    if (!tools || !driver) {
      const missing = [!tools && "tools:registry", !driver && "driver:run-conversation"].filter(Boolean).join(", ");
      void ctx.emit("session:error", { message: `llm-agents: missing required service(s): ${missing}; dispatch_agent disabled` });
    } else {
      const dispatch = makeDispatchTool({
        registry: handle,
        tracker,
        driver,
        maxDepth: config.maxDepth,
        hasSkills: () => !!ctx.useService("skills:registry"),
      });
      const realHandler = dispatch.handler;
      const guardedHandler: typeof realHandler = async (args, tCtx) => {
        if (!ready) throw new Error("Agent registry still loading; retry");
        return realHandler(args, tCtx);
      };
      tools.register(dispatch.schema, guardedHandler);
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
        handle.setInner(makeRegistry(result.manifests));
        ready = true;
        for (const e of result.errors) {
          await ctx.emit("session:error", { message: `llm-agents: ${e.path}: ${e.message}` });
        }
      } catch (err) {
        ready = true;
        await ctx.emit("session:error", { message: `llm-agents: discovery failed: ${(err as Error).message}` });
      }
    });
  },
};

export default plugin;
