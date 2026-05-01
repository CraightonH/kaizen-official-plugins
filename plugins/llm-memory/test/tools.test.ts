import { describe, it, expect, mock } from "bun:test";
import { registerTools } from "../tools.ts";
import type { MemoryStoreService, MemoryEntry } from "../public.d.ts";

function fakeStore(): { svc: MemoryStoreService; calls: any } {
  const state: MemoryEntry[] = [];
  const calls: any = { put: [] as MemoryEntry[], get: [] as string[] };
  const svc: MemoryStoreService = {
    async get(name) { calls.get.push(name); return state.find((e) => e.name === name) ?? null; },
    async list() { return state; },
    async search(q) { return state.filter((e) => e.description.includes(q) || e.name.startsWith(q)); },
    async put(entry) { calls.put.push(entry); const i = state.findIndex((e) => e.name === entry.name); if (i >= 0) state[i] = entry; else state.push(entry); },
    async remove() {},
    async readIndex() { return ""; },
  };
  return { svc, calls };
}

function fakeRegistry() {
  const registered: { schema: any; handler: any }[] = [];
  return {
    registry: {
      register: mock((schema: any, handler: any) => { registered.push({ schema, handler }); return () => {}; }),
      list: mock(() => registered.map((r) => r.schema)),
      invoke: mock(async () => undefined),
    },
    registered,
  };
}

const ctx: any = { signal: new AbortController().signal, callId: "c1", log: () => {} };

describe("registerTools", () => {
  it("registers two tools tagged memory", () => {
    const { svc } = fakeStore();
    const { registry, registered } = fakeRegistry();
    registerTools(registry as any, svc, { log: () => {}, denyTypes: [] });
    expect(registered.map((r) => r.schema.name).sort()).toEqual(["memory_recall", "memory_save"]);
    for (const r of registered) expect(r.schema.tags).toContain("memory");
  });
  it("memory_recall by names exact-loads and includes body", async () => {
    const { svc } = fakeStore();
    await svc.put({ name: "x", description: "d", type: "user", scope: "global", body: "BODY" });
    const { registry, registered } = fakeRegistry();
    registerTools(registry as any, svc, { log: () => {}, denyTypes: [] });
    const recall = registered.find((r) => r.schema.name === "memory_recall")!.handler;
    const out = await recall({ names: ["x"] }, ctx);
    expect(out.entries[0].body).toBe("BODY");
  });
  it("memory_recall returns structured error for missing names (no throw)", async () => {
    const { svc } = fakeStore();
    const { registry, registered } = fakeRegistry();
    registerTools(registry as any, svc, { log: () => {}, denyTypes: [] });
    const recall = registered.find((r) => r.schema.name === "memory_recall")!.handler;
    const out = await recall({ names: ["nope"] }, ctx);
    expect(out.entries).toEqual([]);
    expect(out.missing).toEqual(["nope"]);
  });
  it("memory_recall fuzzy-match returns up to 5 entries", async () => {
    const { svc } = fakeStore();
    for (let i = 0; i < 10; i++) await svc.put({ name: `n${i}`, description: `vault tip ${i}`, type: "user", scope: "global", body: "" });
    const { registry, registered } = fakeRegistry();
    registerTools(registry as any, svc, { log: () => {}, denyTypes: [] });
    const recall = registered.find((r) => r.schema.name === "memory_recall")!.handler;
    const out = await recall({ query: "vault" }, ctx);
    expect(out.entries.length).toBe(5);
  });
  it("memory_recall respects denyTypes", async () => {
    const { svc } = fakeStore();
    await svc.put({ name: "f", description: "d", type: "feedback", scope: "global", body: "" });
    const { registry, registered } = fakeRegistry();
    registerTools(registry as any, svc, { log: () => {}, denyTypes: ["feedback"] });
    const recall = registered.find((r) => r.schema.name === "memory_recall")!.handler;
    const out = await recall({ names: ["f"] }, ctx);
    expect(out.entries).toEqual([]);
  });
  it("memory_save defaults scope to global and writes the entry", async () => {
    const { svc, calls } = fakeStore();
    const { registry, registered } = fakeRegistry();
    registerTools(registry as any, svc, { log: () => {}, denyTypes: [] });
    const save = registered.find((r) => r.schema.name === "memory_save")!.handler;
    const out = await save({ name: "x", description: "d", content: "B", type: "user" }, ctx);
    expect(out.ok).toBe(true);
    expect(calls.put[0].scope).toBe("global");
  });
  it("memory_save refuses to overwrite without `!` suffix", async () => {
    const { svc } = fakeStore();
    await svc.put({ name: "x", description: "d", type: "user", scope: "global", body: "old" });
    const { registry, registered } = fakeRegistry();
    registerTools(registry as any, svc, { log: () => {}, denyTypes: [] });
    const save = registered.find((r) => r.schema.name === "memory_save")!.handler;
    const out = await save({ name: "x", description: "d", content: "new", type: "user" }, ctx);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/already exists/i);
  });
  it("memory_save with `!` suffix overwrites and strips the suffix", async () => {
    const { svc, calls } = fakeStore();
    await svc.put({ name: "x", description: "d", type: "user", scope: "global", body: "old" });
    const { registry, registered } = fakeRegistry();
    registerTools(registry as any, svc, { log: () => {}, denyTypes: [] });
    const save = registered.find((r) => r.schema.name === "memory_save")!.handler;
    const out = await save({ name: "x!", description: "d", content: "new", type: "user" }, ctx);
    expect(out.ok).toBe(true);
    expect(calls.put.at(-1).name).toBe("x");
    expect(calls.put.at(-1).body).toBe("new");
  });
});
