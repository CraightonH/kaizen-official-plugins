import type { KaizenPlugin } from "kaizen/types";
import { CANCEL_TOOL, CODEMODE_CANCEL_SENTINEL } from "llm-events";
import type { ConfigStoreService } from "llm-contracts/public";
import type { HookEntry, HooksConfig } from "./public";
import { DEFAULT_CONFIG, CONFIG_SCHEMA } from "./config.ts";
import { envify } from "./envify.ts";
import { runHook, type RunnerDeps } from "./runner.ts";

export const MUTABLE_EVENTS: ReadonlySet<string> = new Set([
  "llm:before-call",
  "tool:before-execute",
  "codemode:before-execute",
]);

const plugin: KaizenPlugin = {
  name: "llm-hooks-shell",
  apiVersion: "3.0.0",
  permissions: {
    tier: "unscoped",
    exec: { binaries: ["sh"] },
  },
  services: { consumes: ["events:vocabulary", "config:store"] },

  async setup(ctx) {
    const log = (m: string) => ctx.log?.(m);

    const vocabObj = ctx.useService<Record<string, string>>("events:vocabulary") ?? {};
    const vocab = new Set(Object.values(vocabObj));

    // Load config (topo-hint optional).
    let config: HooksConfig = { ...DEFAULT_CONFIG };
    const cfgSvc = ctx.useService<ConfigStoreService>("config:store");
    if (cfgSvc) {
      try {
        cfgSvc.register<HooksConfig>({
          plugin: "llm-hooks-shell",
          defaults: { ...DEFAULT_CONFIG },
          schema: CONFIG_SCHEMA,
        });
        config = cfgSvc.get<HooksConfig>("llm-hooks-shell");
      } catch (e) {
        log(`llm-hooks-shell: config:store register failed (${(e as Error).message}); using defaults`);
      }
    } else {
      log("llm-hooks-shell: config:store unavailable; using DEFAULT_CONFIG");
    }

    const entries: HookEntry[] = Array.isArray(config.hooks) ? config.hooks : [];
    const defaultTimeoutMs = config.defaultTimeoutMs ?? DEFAULT_CONFIG.defaultTimeoutMs;
    const depthCap = config.depthCap ?? DEFAULT_CONFIG.depthCap;

    // Validate every entry's event against the vocabulary (fail loud).
    for (const e of entries) {
      if (!vocab.has(e.event)) {
        throw new Error(`llm-hooks-shell: unknown event "${e.event}" in entry: ${JSON.stringify(e)}`);
      }
    }
    // Warn on block_on_nonzero for non-mutable events.
    for (const e of entries) {
      if (e.block_on_nonzero && !MUTABLE_EVENTS.has(e.event)) {
        ctx.log(`llm-hooks-shell: block_on_nonzero is ignored on non-mutable event "${e.event}" (entry: ${e.command})`);
      }
    }

    if (entries.length === 0) {
      // No hooks configured is the default state — stay silent rather than
      // adding to startup noise.
      return;
    }

    // Group entries by event, preserving order.
    const byEvent = new Map<string, HookEntry[]>();
    for (const e of entries) {
      const arr = byEvent.get(e.event) ?? [];
      arr.push(e);
      byEvent.set(e.event, arr);
    }

    const runnerDeps: RunnerDeps = {
      exec: (bin, args, opts) => ctx.exec.run(bin, args, opts),
      log: (level, msg) => ctx.log(`[${level}] ${msg}`),
    };

    for (const [eventName, hooks] of byEvent.entries()) {
      ctx.on(eventName, async (payload: any) => {
        for (const entry of hooks) {
          const env = envify(eventName, payload, depthCap);
          const outcome = await runHook(entry, env, runnerDeps, defaultTimeoutMs);

          if (outcome.ok) continue;

          // Hook failed. Apply blocking semantics if applicable.
          if (entry.block_on_nonzero && MUTABLE_EVENTS.has(eventName)) {
            if (eventName === "tool:before-execute") {
              payload.args = CANCEL_TOOL;
              await ctx.emit("tool:error", {
                name: payload.name,
                callId: payload.callId,
                message: `cancelled by hook: ${outcome.stderr}`.trim(),
              });
            } else if (eventName === "codemode:before-execute") {
              payload.code = CODEMODE_CANCEL_SENTINEL;
            } else if (eventName === "llm:before-call") {
              if (payload.request) payload.request.cancelled = true;
            }
            // Short-circuit remaining hooks for this event delivery.
            return;
          }
          // Non-blocking failure: continue to next hook.
        }
      });
    }
  },
};

export default plugin;
