import { expect, it } from "bun:test";
import plugin from "./index.ts";

const VOCAB = {
  HARNESS_START: "harness:start",
  LLM_BEFORE_CALL: "llm:before-call",
  LLM_DONE: "llm:done",
  TURN_START: "turn:start",
  TURN_END: "turn:end",
  TOOL_BEFORE_EXECUTE: "tool:before-execute",
  TOOL_RESULT: "tool:result",
  TOOL_ERROR: "tool:error",
  CONVERSATION_CLEARED: "conversation:cleared",
  SESSION_ACTIVE_CHANGED: "session:active-changed",
  SESSION_RENAMED: "session:renamed",
  STATUS_ITEM_UPDATE: "status:item-update",
  STATUS_ITEM_CLEAR: "status:item-clear",
};

it("setup subscribes to status source events", async () => {
  const subscribed: string[] = [];
  const ctx = {
    config: {},
    log: (_m: string) => {},
    defineService: (_n: string, _o: unknown) => {},
    provideService: (_n: string, _v: unknown) => {},
    consumeService: (_n: string) => {},
    useService: (n: string) => n === "events:vocabulary" ? VOCAB : undefined,
    defineEvent: (_n: string) => {},
    emit: async () => [],
    on: (n: string, _h: unknown) => { subscribed.push(n); },
    _testCostDeps: {
      home: "/home/u",
      readFile: async () => JSON.stringify({ rates: {} }),
    },
  };

  await plugin.setup(ctx as any);
  expect(subscribed).toContain("harness:start");
  expect(subscribed).toContain("llm:done");
});
