import type { KaizenPlugin } from "kaizen/types";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { harnessKey } from "./harness-key";
import { makeStore, type SessionsStoreService } from "./store";
import { makeTraceSubscriber } from "./trace-subscriber";

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

const plugin: KaizenPlugin = {
  name: "llm-session-manager",
  apiVersion: "3.0.0",
  permissions: {
    tier: "scoped",
    fs: { read: ["~/.kaizen/sessions/**"], write: ["~/.kaizen/sessions/**"] },
    events: { subscribe: TRACE_EVENTS },
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
  },
};

export default plugin;
