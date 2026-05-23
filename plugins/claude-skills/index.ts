import type { KaizenPlugin } from "kaizen/types";
import type { SkillsRegistryService, ConfigStoreService } from "llm-contracts/public";
import { homedir } from "node:os";
import { join } from "node:path";
import { scanRoots } from "./scan.ts";
import { reconcile, type RegistrarSnapshot } from "./registrar.ts";

interface ClaudeSkillsConfig {
  rescanIntervalMs: number;
}

const DEFAULTS: ClaudeSkillsConfig = { rescanIntervalMs: 30000 };

function readEnv(ctx: any, key: string): string | undefined {
  const fromCtx = ctx.env && typeof ctx.env === "object" ? (ctx.env as Record<string, string | undefined>)[key] : undefined;
  if (typeof fromCtx === "string" && fromCtx.length > 0) return fromCtx;
  const fromProc = process.env[key];
  return fromProc && fromProc.length > 0 ? fromProc : undefined;
}

function resolveRoots(ctx: any): { projectRoot: string; userRoot: string; pluginCacheRoot: string } {
  const home = readEnv(ctx, "HOME") ?? homedir();
  const cwd = typeof ctx.cwd === "string" && ctx.cwd.length > 0 ? ctx.cwd : process.cwd();
  return {
    projectRoot: join(cwd, ".claude", "skills"),
    userRoot: join(home, ".claude", "skills"),
    pluginCacheRoot: join(home, ".claude", "plugins", "cache"),
  };
}

let snapshot: RegistrarSnapshot = new Map();
let unwatchConfig: (() => void) | undefined;
let currentIntervalMs = DEFAULTS.rescanIntervalMs;

const plugin: KaizenPlugin = {
  name: "claude-skills",
  apiVersion: "3.0.0",
  permissions: { tier: "unscoped" },
  services: { consumes: ["skills:registry", "config:store"] },

  async setup(ctx) {
    ctx.consumeService("skills:registry");
    ctx.consumeService("config:store");

    const skills = ctx.useService<SkillsRegistryService>("skills:registry");
    if (!skills) throw new Error("claude-skills: skills:registry service not available");

    const cfgSvc = ctx.useService<ConfigStoreService>("config:store");
    if (!cfgSvc) throw new Error("claude-skills: config:store service not available");

    cfgSvc.register<ClaudeSkillsConfig>({
      plugin: "claude-skills",
      defaults: { ...DEFAULTS },
      schema: {
        rescanIntervalMs: { type: "number", integer: true, min: 1 },
      },
      envVars: { rescanIntervalMs: "KAIZEN_CLAUDE_SKILLS_RESCAN_MS" },
    });
    const initialCfg = cfgSvc.get<ClaudeSkillsConfig>("claude-skills");
    currentIntervalMs = initialCfg.rescanIntervalMs;
    unwatchConfig = cfgSvc.watch<ClaudeSkillsConfig>("claude-skills", (next) => {
      currentIntervalMs = next.rescanIntervalMs;
    });

    const roots = resolveRoots(ctx);
    const hooks = {
      onError: (m: string) => { void ctx.emit("harness:error", { message: m }); },
      // Disabled — see scan.ts dedup-log call. Re-enable to surface dedup info.
      // log: (m: string) => { ctx.log(m); },
      log: (_m: string) => { /* intentionally silent */ },
    };

    const initial = await scanRoots(roots, hooks);
    snapshot = reconcile(skills, initial, snapshot);

    let lastScanAt = Date.now();
    ctx.on("turn:start", async () => {
      const now = Date.now();
      if (now - lastScanAt < currentIntervalMs) return;
      lastScanAt = now;
      try {
        const current = await scanRoots(roots, hooks);
        snapshot = reconcile(skills, current, snapshot);
      } catch (e) {
        void ctx.emit("harness:error", { message: `claude-skills: rescan failed: ${(e as Error).message}` });
      }
    });
  },

  async stop() {
    for (const entry of snapshot.values()) {
      try { entry.unregister(); } catch { /* idempotent */ }
    }
    snapshot = new Map();
    try { unwatchConfig?.(); } catch { /* idempotent */ }
    unwatchConfig = undefined;
  },
};

export default plugin;
