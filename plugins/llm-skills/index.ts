import type { KaizenPlugin } from "kaizen/types";
import type { SkillsRegistryService, ToolsRegistryService } from "llm-events/public";
import type { SystemPromptService } from "llm-system-prompt/public";
import { homedir } from "node:os";
import { join } from "node:path";
import { makeRegistry, type SkillsRegistryServiceImpl } from "./registry.ts";
import { buildSkillsBlock } from "./injection.ts";
import { LOAD_SKILL_SCHEMA, makeLoadSkillHandler } from "./tool.ts";

const DEFAULT_RESCAN_MS = 30000;

function readEnv(ctx: any, key: string): string | undefined {
  // Prefer ctx.env if the harness exposes it; fall back to process.env.
  const fromCtx = ctx.env && typeof ctx.env === "object" ? (ctx.env as any)[key] : undefined;
  if (typeof fromCtx === "string" && fromCtx.length > 0) return fromCtx;
  const fromProc = process.env[key];
  return fromProc && fromProc.length > 0 ? fromProc : undefined;
}

function resolveUserRoot(ctx: any): string {
  const override = readEnv(ctx, "KAIZEN_LLM_SKILLS_PATH");
  if (override) {
    // Spec: colon-separated override; v0 honours the first segment.
    return override.split(":")[0]!;
  }
  const home = readEnv(ctx, "HOME") ?? homedir();
  return join(home, ".kaizen", "skills");
}

function resolveProjectRoot(ctx: any): string {
  const cwd = typeof ctx.cwd === "string" && ctx.cwd.length > 0 ? ctx.cwd : process.cwd();
  return join(cwd, ".kaizen", "skills");
}

function rescanIntervalMs(ctx: any): number {
  const raw = readEnv(ctx, "KAIZEN_LLM_SKILLS_RESCAN_MS");
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RESCAN_MS;
}

const plugin: KaizenPlugin = {
  name: "llm-skills",
  apiVersion: "3.0.0",
  permissions: { tier: "unscoped" },
  services: {
    provides: ["skills:registry"],
    // tools:registry is optional (A-tier harnesses may omit it), but if a
    // provider IS in the harness we want to initialize after it so
    // load_skill can register. Without this edge, kaizen's topo-sort has
    // no reason to order us after llm-tools-registry and useService
    // fails even though the registry is configured.
    consumes: ["tools:registry", "prompt:system"],
  },

  async setup(ctx) {
    const projectRoot = resolveProjectRoot(ctx);
    const userRoot = resolveUserRoot(ctx);
    const interval = rescanIntervalMs(ctx);

    // Resolve prompt:system early so onChange can call bumpGeneration.
    const promptSystem = ctx.useService<SystemPromptService>("prompt:system");
    let sectionHandle: { bumpGeneration(): void; unregister(): void } | undefined;

    const registry: SkillsRegistryServiceImpl = makeRegistry({
      projectRoot,
      userRoot,
      warn: (m) => ctx.log(m),
      error: (m) => { void ctx.emit("session:error", { message: m }); },
      onChange: () => { sectionHandle?.bumpGeneration(); },
    });

    // Initial scan.
    const initial = await registry.rescan();

    ctx.defineService("skills:registry", { description: "Skill discovery + on-demand loading." });
    ctx.provideService<SkillsRegistryService>("skills:registry", registry);

    void ctx.emit("skill:available-changed", { count: initial.count });

    // Register prompt:system section for available skills.
    if (promptSystem) {
      sectionHandle = promptSystem.register({
        id: "llm-skills:available",
        priority: 160,
        title: "Available skills",
        render: () => buildSkillsBlock(registry.list()),
      });
      // Bump after initial scan so generation is fresh.
      sectionHandle.bumpGeneration();
    } else {
      void ctx.emit("session:error", { message: "llm-skills: missing required service(s): prompt:system; available-skills section disabled" });
    }

    // Throttled rescan on turn:start.
    let lastScanAt = Date.now();
    ctx.on("turn:start", async () => {
      const now = Date.now();
      if (now - lastScanAt < interval) return;
      lastScanAt = now;
      const r = await registry.rescan();
      if (r.changed) {
        void ctx.emit("skill:available-changed", { count: r.count });
        sectionHandle?.bumpGeneration();
      }
    });

    // Register load_skill into tools:registry if available.
    let tools: ToolsRegistryService | undefined;
    try {
      tools = ctx.useService("tools:registry");
    } catch {
      tools = undefined;
    }
    let unregisterTool: (() => void) | undefined;
    if (tools && typeof tools.registerWith === "function") {
      const handler = makeLoadSkillHandler(registry, (event, payload) => ctx.emit(event, payload));
      unregisterTool = tools.registerWith({ schema: LOAD_SKILL_SCHEMA, handler, source: { kind: "skill" } });
    } else if (tools && typeof (tools as any).register === "function") {
      const handler = makeLoadSkillHandler(registry, (event, payload) => ctx.emit(event, payload));
      unregisterTool = (tools as any).register(LOAD_SKILL_SCHEMA, handler);
    } else {
      ctx.log("[llm-skills] tools:registry not available; load_skill not registered");
    }

    // Optional teardown if the harness calls stop().
    (plugin as any)._stop = () => {
      unregisterTool?.();
      sectionHandle?.unregister();
    };
  },

  async stop() {
    const fn = (plugin as any)._stop;
    if (typeof fn === "function") fn();
  },
};

export default plugin;
