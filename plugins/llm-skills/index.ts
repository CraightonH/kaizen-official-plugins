import type { KaizenPlugin } from "kaizen/types";
import type { SkillsRegistryService, ToolSchema } from "llm-events/public";
import { homedir } from "node:os";
import { join } from "node:path";
import { makeRegistry, type SkillsRegistryServiceImpl } from "./registry.ts";
import { applyInjection } from "./injection.ts";
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
  services: { provides: ["skills:registry"] },

  async setup(ctx) {
    const projectRoot = resolveProjectRoot(ctx);
    const userRoot = resolveUserRoot(ctx);
    const interval = rescanIntervalMs(ctx);

    const registry: SkillsRegistryServiceImpl = makeRegistry({
      projectRoot,
      userRoot,
      warn: (m) => ctx.log(m),
      error: (m) => { void ctx.emit("session:error", { message: m }); },
    });

    // Initial scan.
    const initial = await registry.rescan();

    ctx.defineService("skills:registry", { description: "Skill discovery + on-demand loading." });
    ctx.provideService<SkillsRegistryService>("skills:registry", registry);

    void ctx.emit("skill:available-changed", { count: initial.count });

    // System-prompt injection.
    ctx.on("llm:before-call", async (payload: { request: { systemPrompt?: string } }) => {
      applyInjection(payload.request, registry.list());
    });

    // Throttled rescan on turn:start.
    let lastScanAt = Date.now();
    ctx.on("turn:start", async () => {
      const now = Date.now();
      if (now - lastScanAt < interval) return;
      lastScanAt = now;
      const r = await registry.rescan();
      if (r.changed) {
        void ctx.emit("skill:available-changed", { count: r.count });
      }
    });

    // Register load_skill into tools:registry if available.
    let tools:
      | { register: (s: ToolSchema, h: (a: unknown, c: any) => Promise<unknown>) => () => void }
      | undefined;
    try {
      tools = ctx.useService("tools:registry");
    } catch {
      tools = undefined;
    }
    let unregisterTool: (() => void) | undefined;
    if (tools && typeof tools.register === "function") {
      const handler = makeLoadSkillHandler(registry, (event, payload) => ctx.emit(event, payload));
      unregisterTool = tools.register(LOAD_SKILL_SCHEMA, handler);
    } else {
      ctx.log("[llm-skills] tools:registry not available; load_skill not registered");
    }

    // Optional teardown if the harness calls stop().
    (plugin as any)._stop = () => { unregisterTool?.(); };
  },

  async stop() {
    const fn = (plugin as any)._stop;
    if (typeof fn === "function") fn();
  },
};

export default plugin;
