import { describe, expect, test } from "bun:test";
import { makeTraceSubscriber } from "../trace-subscriber";

function fakeStore() {
  const calls: Array<{ sessionId: string; event: string; payload: any }> = [];
  return {
    calls,
    internalAppendEvent: async (sessionId: string, _ts: number, event: string, payload: any) => {
      calls.push({ sessionId, event, payload });
    },
  };
}

describe("trace subscriber", () => {
  test("routes turn-scoped events by turnId and clears on turn:end", async () => {
    const store = fakeStore();
    const sub = makeTraceSubscriber({ store: store as any, now: () => 1, log: () => {} });
    await sub.handle("turn:start", { turnId: "t1", sessionId: "s1" });
    await sub.handle("llm:request", { turnId: "t1", request: {} });
    await sub.handle("turn:end", { turnId: "t1" });
    await sub.handle("llm:done", { turnId: "t1", response: {} });
    expect(store.calls.map((call) => call.event)).toEqual(["turn:start", "llm:request", "turn:end"]);
  });

  test("skips unowned/noisy events and logs write failures", async () => {
    const logs: string[] = [];
    const sub = makeTraceSubscriber({
      store: { internalAppendEvent: async () => { throw new Error("disk full"); } } as any,
      now: () => 1,
      log: (msg) => logs.push(msg),
    });
    await sub.handle("llm:token", { turnId: "t1" });
    await sub.handle("llm:request", {});
    await sub.handle("turn:start", { turnId: "t1", sessionId: "s1" });
    expect(logs.join("\n")).toContain("disk full");
  });
});
