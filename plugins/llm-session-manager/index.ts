import type { KaizenPlugin } from "kaizen/types";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { harnessKey } from "./harness-key";
import { makeStore, type SessionsStoreService } from "./store";
import { makeTraceSubscriber } from "./trace-subscriber";
import { makeCommands } from "./commands.ts";
import { registerSlashCommands, type SlashRegistryLike } from "./slash.ts";
import { registerToolCommands, type ToolsRegistryLike } from "./tools.ts";

interface SessionManagerConfig {
  sessionsBase?: string;
}

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

const LIFECYCLE_EVENTS = ["harness:start", "session:active-changed"];

const plugin: KaizenPlugin = {
  name: "llm-session-manager",
  apiVersion: "3.0.0",
  permissions: {
    tier: "scoped",
    fs: { read: ["~/.kaizen/sessions/**"], write: ["~/.kaizen/sessions/**"] },
    events: { subscribe: [...TRACE_EVENTS, ...LIFECYCLE_EVENTS] },
  },
  services: {
    consumes: ["llm-events:vocabulary"],
    provides: ["sessions:store"],
  },

  async setup(ctx) {
    ctx.consumeService("llm-events:vocabulary");
    const config = (ctx.config ?? {}) as SessionManagerConfig;
    const sessionsBase = config.sessionsBase ?? join(homedir(), ".kaizen", "sessions");
    const key = harnessKey(ctx.harness ?? {});
    const store = makeStore({
      sessionsBase,
      harnessKey: key,
      pluginFingerprint: ["llm-session-manager@0.1.0"],
      now: () => Date.now(),
      newUuid: () => randomUUID(),
      log: ctx.log.bind(ctx),
      emit: ctx.emit.bind(ctx),
    });

    ctx.defineService("sessions:store", {
      description: "Persistent session store with per-turn commit/rollback and append-only traces.",
    });
    ctx.provideService<SessionsStoreService>("sessions:store", store);

    let activeSessionId: string | null = null;
    ctx.on("session:active-changed", (payload: any) => {
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
    ctx.on("harness:start", () => {
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
