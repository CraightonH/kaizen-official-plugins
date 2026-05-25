import type { KaizenPlugin } from "kaizen/types";
import { randomUUID } from "node:crypto";
import pkg from "./package.json" with { type: "json" };
import { harnessKey } from "./harness-key";
import type { SessionsStoreService, ConfigStoreService } from "llm-contracts/public";
import type { SessionManagerConfig } from "./public.d.ts";
import { DEFAULT_CONFIG, CONFIG_SCHEMA } from "./config.ts";
import { makeStore } from "./store";
import { makeTraceSubscriber } from "./trace-subscriber";
import { makeCommands } from "./commands.ts";
import { registerSlashCommands, type SlashRegistryLike } from "./slash.ts";
import { registerToolCommands, type ToolsRegistryLike } from "./tools.ts";

const TRACE_EVENTS = [
  "session:renamed",
  "turn:start",
  "turn:end",
  "turn:error",
  "turn:cancel",
  "llm:request",
  "llm:done",
  "llm:error",
  "tool:before-execute",
  "tool:execute",
  "tool:result",
  "tool:error",
  "codemode:code-emitted",
  "codemode:before-execute",
  "codemode:result",
  "codemode:error",
];

// Events subscribed for lifecycle bookkeeping (active-session tracking +
// deferred slash/tool adapter registration).
const LIFECYCLE_EVENTS = ["harness:start", "session:active-changed"] as const;

const plugin: KaizenPlugin = {
  name: "llm-session-manager",
  apiVersion: "3.0.0",
  permissions: {
    tier: "scoped",
    fs: { read: ["~/.kaizen/sessions/**"], write: ["~/.kaizen/sessions/**"] },
    events: { subscribe: [...TRACE_EVENTS, ...LIFECYCLE_EVENTS] },
  },
  services: {
    consumes: ["events:vocabulary", "config:store"],
    provides: ["sessions:store"],
  },

  async setup(ctx) {
    const log = (m: string) => ctx.log?.(m);

    // Load config (topo-hint optional).
    let config: SessionManagerConfig = { ...DEFAULT_CONFIG };
    const cfgSvc = ctx.useService<ConfigStoreService>("config:store");
    if (cfgSvc) {
      try {
        cfgSvc.register<SessionManagerConfig>({
          plugin: "llm-session-manager",
          defaults: { ...DEFAULT_CONFIG },
          schema: CONFIG_SCHEMA,
        });
        config = cfgSvc.get<SessionManagerConfig>("llm-session-manager");
      } catch (e) {
        log(`llm-session-manager: config:store register failed (${(e as Error).message}); using defaults`);
      }
    } else {
      log("llm-session-manager: config:store unavailable; using DEFAULT_CONFIG");
    }

    const sessionsBase = config.sessionsBase;
    // ctx.harness is a Kaizen runtime extension not yet on PluginContext.
    const key = harnessKey((ctx as { harness?: import("./harness-key").HarnessIdentity }).harness ?? {});
    const store = makeStore({
      sessionsBase,
      harnessKey: key,
      pluginFingerprint: [`${pkg.name}@${pkg.version}`],
      now: () => Date.now(),
      newUuid: () => randomUUID(),
      log: ctx.log.bind(ctx),
      emit: ctx.emit.bind(ctx),
    });

    ctx.provideService<SessionsStoreService>("sessions:store", store);

    let activeSessionId: string | null = null;
    ctx.on("session:active-changed", async (payload: any) => {
      if (typeof payload?.to === "string") activeSessionId = payload.to;
    });

    const subscriber = makeTraceSubscriber({
      store,
      now: () => Date.now(),
      log: ctx.log.bind(ctx),
    });
    for (const event of TRACE_EVENTS) {
      ctx.on(event, async (payload: any) => {
        await subscriber.handle(event, payload);
      });
    }

    // Register slash + tool adapters on harness:start so consumed registries
    // are guaranteed to be provided. Both are soft dependencies.
    ctx.on("harness:start", async () => {
      const cmds = makeCommands({ store, emit: ctx.emit.bind(ctx), getActiveSessionId: () => activeSessionId });
      try {
        const slash = ctx.useService<SlashRegistryLike>("slash:registry");
        if (slash) registerSlashCommands(slash, cmds);
      } catch { /* slash:registry absent — skip */ }
      try {
        const toolsReg = ctx.useService<ToolsRegistryLike>("tools:registry");
        if (toolsReg) registerToolCommands(toolsReg, cmds);
      } catch { /* tools:registry absent — skip */ }
    });
  },
};

export default plugin;
