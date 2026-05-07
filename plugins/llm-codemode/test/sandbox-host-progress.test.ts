import { test, expect } from "bun:test";
import { runInSandbox } from "../sandbox-host.ts";
import { DEFAULT_CONFIG } from "../config.ts";
import type { ToolsRegistryService, ToolSchema } from "llm-events/public";

const makeFakeRegistry = (): ToolsRegistryService => ({
  register: () => () => {},
  list: () => [] as ToolSchema[],
  invoke: async () => null,
});

test("emits tool:progress with stdout deltas when outerCallId is provided", async () => {
  const events: Array<{ name: string; payload: any }> = [];
  const emit = async (name: string, payload: unknown) => { events.push({ name, payload: payload as any }); };
  const registry = makeFakeRegistry();
  const config = { ...DEFAULT_CONFIG, timeoutMs: 5000 };
  const ac = new AbortController();
  await runInSandbox(
    'console.log("hello"); 1 + 1;',
    registry,
    ac.signal,
    config,
    emit,
    "turn-1",
    "sess-1",
    "outer-call-1",
  );
  const progress = events.filter((e) => e.name === "tool:progress");
  expect(progress.length).toBeGreaterThanOrEqual(1);
  expect(progress[0]?.payload.callId).toBe("outer-call-1");
  expect(progress.map((e) => e.payload.delta).join("")).toContain("hello");
});

test("does NOT emit tool:progress when outerCallId is omitted", async () => {
  const events: Array<{ name: string; payload: any }> = [];
  const emit = async (name: string, payload: unknown) => { events.push({ name, payload: payload as any }); };
  const registry = makeFakeRegistry();
  const config = { ...DEFAULT_CONFIG, timeoutMs: 5000 };
  const ac = new AbortController();
  await runInSandbox(
    'console.log("hi"); 1;',
    registry,
    ac.signal,
    config,
    emit,
    "turn-1",
    "sess-1",
  );
  const progress = events.filter((e) => e.name === "tool:progress");
  expect(progress.length).toBe(0);
});
