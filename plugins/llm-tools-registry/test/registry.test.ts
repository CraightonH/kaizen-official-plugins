import { describe, it, expect, mock } from "bun:test";
import { makeRegistry } from "../registry.ts";
import { CANCEL_TOOL } from "llm-events";
import type { ToolSchema } from "llm-events/public";

const SCHEMA = (name: string, tags?: string[]): ToolSchema => ({
  name,
  description: `${name} desc`,
  parameters: { type: "object", properties: {}, additionalProperties: false } as any,
  tags,
});

function captureEmit() {
  const events: { name: string; payload: any }[] = [];
  const subscribers: Record<string, ((p: any) => Promise<void> | void)[]> = {};
  const emit = mock(async (name: string, payload: unknown) => {
    events.push({ name, payload });
    for (const fn of subscribers[name] ?? []) await fn(payload);
  });
  function on(name: string, fn: (p: any) => Promise<void> | void) {
    (subscribers[name] ??= []).push(fn);
  }
  return { emit, on, events };
}

const ctx = (callId = "c1") => ({
  signal: new AbortController().signal,
  callId,
  log: () => {},
});

describe("makeRegistry — register/list/unregister", () => {
  it("register then list returns the schema", () => {
    const { emit } = captureEmit();
    const r = makeRegistry(emit as any);
    r.register(SCHEMA("a"), async () => "ok");
    expect(r.list().map((s) => s.name)).toEqual(["a"]);
  });

  it("unregister removes the entry", () => {
    const { emit } = captureEmit();
    const r = makeRegistry(emit as any);
    const off = r.register(SCHEMA("a"), async () => "ok");
    off();
    expect(r.list()).toEqual([]);
  });

  it("duplicate register throws", () => {
    const { emit } = captureEmit();
    const r = makeRegistry(emit as any);
    r.register(SCHEMA("a"), async () => "ok");
    expect(() => r.register(SCHEMA("a"), async () => "ok")).toThrow(/already registered/);
  });

  it("empty name rejected", () => {
    const { emit } = captureEmit();
    const r = makeRegistry(emit as any);
    expect(() => r.register(SCHEMA(""), async () => "ok")).toThrow(/name/);
  });

  it("unregister is idempotent", () => {
    const { emit } = captureEmit();
    const r = makeRegistry(emit as any);
    const off = r.register(SCHEMA("a"), async () => "ok");
    off();
    off(); // second call: no throw
    expect(r.list()).toEqual([]);
  });

  it("unregister does not remove a same-named replacement", () => {
    const { emit } = captureEmit();
    const r = makeRegistry(emit as any);
    const off1 = r.register(SCHEMA("a"), async () => "v1");
    off1();
    r.register(SCHEMA("a"), async () => "v2");
    off1(); // identifies entry by reference
    expect(r.list().map((s) => s.name)).toEqual(["a"]);
  });

  it("list({ tags }) any-match", () => {
    const { emit } = captureEmit();
    const r = makeRegistry(emit as any);
    r.register(SCHEMA("a", ["fs"]), async () => "");
    r.register(SCHEMA("b", ["net"]), async () => "");
    r.register(SCHEMA("c", ["fs", "net"]), async () => "");
    expect(r.list({ tags: ["fs"] }).map((s) => s.name)).toEqual(["a", "c"]);
  });

  it("list({ names })", () => {
    const { emit } = captureEmit();
    const r = makeRegistry(emit as any);
    r.register(SCHEMA("a"), async () => "");
    r.register(SCHEMA("b"), async () => "");
    expect(r.list({ names: ["b"] }).map((s) => s.name)).toEqual(["b"]);
  });

  it("list({ tags, names }) AND-combined", () => {
    const { emit } = captureEmit();
    const r = makeRegistry(emit as any);
    r.register(SCHEMA("a", ["fs"]), async () => "");
    r.register(SCHEMA("b", ["fs"]), async () => "");
    r.register(SCHEMA("c", ["net"]), async () => "");
    expect(r.list({ tags: ["fs"], names: ["b", "c"] }).map((s) => s.name)).toEqual(["b"]);
  });

  it("list returns a clone (mutating result does not mutate registry)", () => {
    const { emit } = captureEmit();
    const r = makeRegistry(emit as any);
    r.register(SCHEMA("a"), async () => "");
    const out = r.list();
    out.length = 0;
    expect(r.list().length).toBe(1);
  });
});

describe("makeRegistry — invoke", () => {
  it("unknown tool emits tool:error and rejects", async () => {
    const { emit, events } = captureEmit();
    const r = makeRegistry(emit as any);
    await expect(r.invoke("nope", {}, ctx())).rejects.toThrow(/unknown tool/);
    expect(events.map((e) => e.name)).toEqual(["tool:error"]);
    expect(events[0].payload).toMatchObject({ name: "nope", callId: "c1", message: expect.stringMatching(/unknown tool/) });
  });

  it("happy path emits before-execute, execute, result in order", async () => {
    const { emit, events } = captureEmit();
    const r = makeRegistry(emit as any);
    r.register(SCHEMA("a"), async (args) => ({ echoed: args }));
    const result = await r.invoke("a", { x: 1 }, ctx());
    expect(result).toEqual({ echoed: { x: 1 } });
    expect(events.map((e) => e.name)).toEqual(["tool:before-execute", "tool:execute", "tool:result"]);
    expect(events[0].payload).toMatchObject({ name: "a", args: { x: 1 }, callId: "c1" });
    expect(events[2].payload).toMatchObject({ name: "a", callId: "c1", result: { echoed: { x: 1 } } });
  });

  it("subscriber that mutates args is observed by handler and tool:execute", async () => {
    const { emit, on, events } = captureEmit();
    const r = makeRegistry(emit as any);
    on("tool:before-execute", (p) => { p.args = { rewritten: true }; });
    let seenByHandler: unknown = null;
    r.register(SCHEMA("a"), async (args) => { seenByHandler = args; return "ok"; });
    await r.invoke("a", { original: true }, ctx());
    expect(seenByHandler).toEqual({ rewritten: true });
    const exec = events.find((e) => e.name === "tool:execute")!;
    expect(exec.payload).toMatchObject({ args: { rewritten: true } });
  });

  it("subscriber that sets args = CANCEL_TOOL short-circuits", async () => {
    const { emit, on, events } = captureEmit();
    const r = makeRegistry(emit as any);
    on("tool:before-execute", (p) => { p.args = CANCEL_TOOL; });
    let handlerCalled = false;
    r.register(SCHEMA("a"), async () => { handlerCalled = true; return "ok"; });
    await expect(r.invoke("a", {}, ctx())).rejects.toThrow(/cancelled/);
    expect(handlerCalled).toBe(false);
    expect(events.map((e) => e.name)).toEqual(["tool:before-execute", "tool:error"]);
  });

  it("handler throw emits tool:error and re-rejects with original error", async () => {
    const { emit, events } = captureEmit();
    const r = makeRegistry(emit as any);
    const boom = new Error("boom");
    r.register(SCHEMA("a"), async () => { throw boom; });
    await expect(r.invoke("a", {}, ctx())).rejects.toBe(boom);
    expect(events.map((e) => e.name)).toEqual(["tool:before-execute", "tool:execute", "tool:error"]);
    expect(events[2].payload).toMatchObject({ name: "a", callId: "c1", message: "boom", cause: boom });
  });

  it("two concurrent invokes have independent event streams", async () => {
    const { emit, events } = captureEmit();
    const r = makeRegistry(emit as any);
    let resolveA: (v: string) => void = () => {};
    let resolveB: (v: string) => void = () => {};
    r.register(SCHEMA("a"), () => new Promise<string>((res) => { resolveA = res; }));
    r.register(SCHEMA("b"), () => new Promise<string>((res) => { resolveB = res; }));
    const pa = r.invoke("a", {}, ctx("ca"));
    const pb = r.invoke("b", {}, ctx("cb"));
    // Yield to the microtask queue so both handlers are called and resolvers are populated.
    await new Promise((r) => setTimeout(r, 0));
    resolveB("rb");
    resolveA("ra");
    await Promise.all([pa, pb]);
    const ca = events.filter((e) => (e.payload as any).callId === "ca").map((e) => e.name);
    const cb = events.filter((e) => (e.payload as any).callId === "cb").map((e) => e.name);
    expect(ca).toEqual(["tool:before-execute", "tool:execute", "tool:result"]);
    expect(cb).toEqual(["tool:before-execute", "tool:execute", "tool:result"]);
  });
});
