import type { KaizenPlugin } from "kaizen/types";
import type { SkillsRegistryService, ConfigStoreService } from "llm-contracts/public";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ClaudeSkillsConfig } from "./public.d.ts";
import { DEFAULT_CONFIG, CONFIG_SCHEMA } from "./config.ts";
import { scanRoots } from "./scan.ts";
import { reconcile, type RegistrarSnapshot } from "./registrar.ts";

function resolveRoots(ctx: any): { projectRoot: string; userRoot: string; pluginCacheRoot: string } {
  const home = homedir();
  const cwd = typeof ctx.cwd === "string" && ctx.cwd.length > 0 ? ctx.cwd : process.cwd();
  return {
    projectRoot: join(cwd, ".claude", "skills"),
    userRoot: join(home, ".claude", "skills"),
    pluginCacheRoot: join(home, ".claude", "plugins", "cache"),
  };
}

let snapshot: RegistrarSnapshot = new Map();
let unwatchConfig: (() => void) | undefined;
let currentIntervalMs = DEFAULT_CONFIG.rescanIntervalMs;

const plugin: KaizenPlugin = {
  name: "claude-skills",
  apiVersion: "3.0.0",
  permissions: { tier: "unscoped" },
  services: { consumes: ["skills:registry", "config:store"] },

  async setup(ctx) {
    const log = (m: string) => ctx.log?.(m);

    const skills = ctx.useService<SkillsRegistryService>("skills:registry");
    if (!skills) throw new Error("claude-skills: skills:registry service not available");

    // Load config (topo-hint optional — falls back to DEFAULT_CONFIG so
    // plugin tests with a fake ctx keep working without spinning up
    // config:store).
    let config: ClaudeSkillsConfig = { ...DEFAULT_CONFIG };
    const cfgSvc = ctx.useService<ConfigStoreService>("config:store");
    if (cfgSvc) {
      try {
        cfgSvc.register<ClaudeSkillsConfig>({
          plugin: "claude-skills",
          defaults: { ...DEFAULT_CONFIG },
          schema: CONFIG_SCHEMA,
        });
        config = cfgSvc.get<ClaudeSkillsConfig>("claude-skills");
      } catch (e) {
        log(`claude-skills: config:store register failed (${(e as Error).message}); using defaults`);
      }
      unwatchConfig = cfgSvc.watch<ClaudeSkillsConfig>("claude-skills", (next) => {
        currentIntervalMs = next.rescanIntervalMs;
      });
    } else {
      log("claude-skills: config:store unavailable; using DEFAULT_CONFIG");
    }
    currentIntervalMs = config.rescanIntervalMs;

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
