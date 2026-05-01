import type { KaizenPlugin } from "kaizen/types";
import { CANCEL_TOOL, CODEMODE_CANCEL_SENTINEL } from "llm-events";
import { loadHookConfigs, MUTABLE_EVENTS, realConfigDeps, type ConfigDeps, type HookEntry } from "./config.ts";
import { envify } from "./envify.ts";
import { runHook, type RunnerDeps } from "./runner.ts";

const plugin: KaizenPlugin = {
  name: "llm-hooks-shell",
  apiVersion: "3.0.0",
  permissions: {
    tier: "unscoped",
    exec: { binaries: ["sh"] },
  },
  services: { consumes: ["llm-events:vocabulary"] },

  async setup(ctx) {
    ctx.consumeService("llm-events:vocabulary");

    const vocabObj = ctx.useService<Record<string, string>>("llm-events:vocabulary") ?? {};
    const vocab = new Set(Object.values(vocabObj));

    const configDeps: ConfigDeps = (ctx as any)._testHookDeps ?? realConfigDeps();
    const { entries, warnings } = await loadHookConfigs(configDeps, vocab);

    for (const w of warnings) ctx.log(w);

    if (entries.length === 0) {
      ctx.log("llm-hooks-shell: no hooks configured (looked at ~/.kaizen/hooks/hooks.json and <cwd>/.kaizen/hooks/hooks.json). Plugin loaded as a no-op.");
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
          const env = envify(eventName, payload);
          const outcome = await runHook(entry, env, runnerDeps);

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
