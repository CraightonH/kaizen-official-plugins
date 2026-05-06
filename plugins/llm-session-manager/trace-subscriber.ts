import type { SessionsStoreService } from "./store";

const LOGGED_EVENTS = new Set([
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
]);

const SKIP_EVENTS = new Set([
  "llm:before-call",
  "llm:token",
  "llm:reasoning",
  "llm:tool-call",
]);

export interface TraceSubscriberDeps {
  store: SessionsStoreService;
  now: () => number;
  log: (msg: string) => void;
}

export function makeTraceSubscriber(deps: TraceSubscriberDeps): {
  handle(event: string, payload: any): Promise<void>;
} {
  const turnToSession = new Map<string, string>();

  return {
    async handle(event, payload) {
      if (SKIP_EVENTS.has(event) || !LOGGED_EVENTS.has(event)) return;
      const turnId = typeof payload?.turnId === "string" ? payload.turnId : undefined;
      if (!turnId) return;

      let sessionId: string | undefined;
      if (event === "turn:start") {
        sessionId = typeof payload?.sessionId === "string" ? payload.sessionId : undefined;
        if (sessionId) turnToSession.set(turnId, sessionId);
      } else {
        sessionId = turnToSession.get(turnId);
      }
      if (!sessionId) return;

      try {
        await deps.store.internalAppendEvent?.(sessionId, deps.now(), event, payload);
      } catch (err) {
        deps.log(`sessions: dropped trace event ${event}: ${String((err as any)?.message ?? err)}`);
        return;
      }

      if (event === "turn:end") turnToSession.delete(turnId);
    },
  };
}
