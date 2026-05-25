import type { KaizenPlugin } from "kaizen/types";
import type { ConfigStoreService, SkillsRegistryService } from "llm-contracts/public";
import type { ToolsRegistryService } from "llm-tools-registry/public";
import type { SystemPromptService } from "llm-contracts/public";
import { homedir } from "node:os";
import { join } from "node:path";
import { makeRegistry, type SkillsRegistryServiceImpl } from "./registry.ts";
import { buildSkillsBlock } from "./injection.ts";
import { LOAD_SKILL_SCHEMA, makeLoadSkillHandler } from "./tool.ts";
import { NEW_SKILL_SCHEMA, makeNewSkillHandler } from "./new-skill.ts";
import { registerSlashCommands } from "./slash-commands.ts";
import type { SlashRegistryService } from "llm-contracts/public";
import type { LlmSkillsConfig } from "./public.d.ts";
import { DEFAULT_CONFIG, CONFIG_SCHEMA } from "./config.ts";

// Expand a leading `~/` (or bare `~`) to the user's home directory.
// Mirrors what shells and most JS path utilities do for user-scope paths.
function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

// Module-scope cleanup handles. setup() populates these; stop() drains them.
let unregisterTool: (() => void) | undefined;
let unregisterNewSkill: (() => void) | undefined;
let sectionHandle: { bumpGeneration(): void; unregister(): void } | undefined;
let unregisterSlashCommands: (() => void) | undefined;

const plugin: KaizenPlugin = {
  name: "llm-skills",
  apiVersion: "3.0.0",
  permissions: { tier: "unscoped" },
  services: {
    provides: ["skills:registry"],
    // tools:registry is functionally optional (load_skill is only registered
    // if it's present), but it's listed here so kaizen's topo-sort orders
    // this plugin AFTER the registry's provider when one exists. Without
    // this edge, useService("tools:registry") may run before the registry
    // is provided and silently miss load_skill registration. This is an
    // acknowledged AGENTS.md edge case: the entry is a topo-sort hint, not
    // a hard boot requirement (no consumeService call backs it up).
    // prompt:registry is optional — the available-skills section is disabled
    // when absent (harness:error emitted), but the plugin otherwise runs fine.
    // slash:registry is topo-hint optional — when present, llm-slash-commands
    // loads first so the registration in setup() succeeds via useService.
    // When absent, the lookup returns undefined and the /skills:* commands
    // are simply not registered. No consumeService backs this entry.
    // config:store is topo-hint optional — boots early (right after
    // llm-contracts) so it is virtually always present in the local harness;
    // when absent, setup() falls back to DEFAULT_CONFIG.
    consumes: ["tools:registry", "slash:registry", "config:store"],
  },

  async setup(ctx) {
    // Load config (topo-hint optional).
    let config: LlmSkillsConfig = { ...DEFAULT_CONFIG };
    const cfgSvc = ctx.useService<ConfigStoreService>("config:store");
    if (cfgSvc) {
      try {
        cfgSvc.register<LlmSkillsConfig>({
          plugin: "llm-skills",
          defaults: { ...DEFAULT_CONFIG },
          schema: CONFIG_SCHEMA,
        });
        config = cfgSvc.get<LlmSkillsConfig>("llm-skills");
      } catch (e) {
        ctx.log(`llm-skills: config:store register failed (${(e as Error).message}); using defaults`);
      }
    } else {
      ctx.log("llm-skills: config:store unavailable; using DEFAULT_CONFIG");
    }

    const userRoot = expandHome(config.userRoot);
    const cwd = typeof ctx.cwd === "string" && ctx.cwd.length > 0 ? ctx.cwd : process.cwd();
    const projectRoot = join(cwd, ".kaizen", "skills");
    // "Never treat 0 as 'always rescan'" invariant (CLAUDE.md): the schema
    // permits min: 0 so user values are not silently reverted by the store,
    // but the runtime clamps to the default when ≤ 0.
    const interval = config.rescanIntervalMs > 0 ? config.rescanIntervalMs : DEFAULT_CONFIG.rescanIntervalMs;

    // Resolve prompt:registry early so onChange can call bumpGeneration.
    const promptSystem = ctx.useService<SystemPromptService>("prompt:registry");

    const registry: SkillsRegistryServiceImpl = makeRegistry({
      projectRoot,
      userRoot,
      warn: (m) => ctx.log(m),
      error: (m) => { void ctx.emit("harness:error", { message: m }); },
      onChange: (info) => {
        sectionHandle?.bumpGeneration();
        if (info) void ctx.emit("skill:available-changed", { count: info.count });
      },
    });

    ctx.provideService<SkillsRegistryService>("skills:registry", registry);

    // Register prompt:system section BEFORE the initial scan so onChange can bump.
    if (promptSystem) {
      sectionHandle = promptSystem.register({
        id: "llm-skills:available",
        priority: 160,
        title: "Available skills",
        render: () => buildSkillsBlock(registry.list()),
      });
    } else {
      void ctx.emit("harness:error", { message: "llm-skills: missing required service(s): prompt:registry; available-skills section disabled" });
    }

    // Initial scan. If skills exist, onChange fires once (bump + emit).
    const initial = await registry.rescan();

    // Empty-registry case: onChange does not fire (no change detected on first
    // rescan when the snapshot stays empty), so emit once explicitly so the
    // existing "emits skill:available-changed once" contract holds.
    if (initial.count === 0) {
      void ctx.emit("skill:available-changed", { count: 0 });
    }

    // Throttled rescan on turn:start.
    let lastScanAt = Date.now();
    ctx.on("turn:start", async () => {
      const now = Date.now();
      if (now - lastScanAt < interval) return;
      lastScanAt = now;
      // bump + emit happen via onChange when the snapshot changes.
      await registry.rescan();
    });

    // Register load_skill into tools:registry if available.
    // useService returns undefined when the service is absent — no try/catch needed.
    const tools = ctx.useService<ToolsRegistryService>("tools:registry");
    if (tools) {
      const handler = makeLoadSkillHandler(registry, async (event, payload) => { await ctx.emit(event, payload); });
      unregisterTool = tools.registerWith({ schema: LOAD_SKILL_SCHEMA, handler, source: { kind: "skill" } });

      const newSkillHandler = makeNewSkillHandler({ projectRoot, userRoot, registry });
      unregisterNewSkill = tools.registerWith({
        schema: NEW_SKILL_SCHEMA,
        handler: newSkillHandler,
        source: { kind: "skill" },
      });
    } else {
      ctx.log("[llm-skills] tools:registry not available; load_skill and new_skill not registered");
    }

    // /skills:list and /skills:get — registered when llm-slash-commands is present.
    // slash:registry is declared in services.consumes as a topo-hint only;
    // useService returns undefined when the harness doesn't include the plugin.
    const slash = ctx.useService<SlashRegistryService>("slash:registry");
    if (slash) {
      unregisterSlashCommands = registerSlashCommands({
        registry,
        slash,
        projectRoot,
        userRoot,
      });
    } else {
      ctx.log("[llm-skills] slash:registry not available; /skills:* commands not registered");
    }
  },

  async stop() {
    try { unregisterTool?.(); } catch { /* idempotent */ }
    try { unregisterNewSkill?.(); } catch { /* idempotent */ }
    try { sectionHandle?.unregister(); } catch { /* idempotent */ }
    try { unregisterSlashCommands?.(); } catch { /* idempotent */ }
    unregisterTool = undefined;
    unregisterNewSkill = undefined;
    sectionHandle = undefined;
    unregisterSlashCommands = undefined;
  },
};

export default plugin;
