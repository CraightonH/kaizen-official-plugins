import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeStore } from "../store";

function setup() {
  let n = 0;
  const emitted: Array<{ event: string; payload: unknown }> = [];
  const store = makeStore({
    sessionsBase: mkdtempSync(join(tmpdir(), "store-")),
    harnessKey: "h",
    pluginFingerprint: ["llm-driver@0.1.0"],
    now: () => 100 + ++n,
    newUuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
    log: () => {},
    emit: async (event, payload) => {
      emitted.push({ event, payload });
      return [];
    },
  });
  return { store, emitted };
}

describe("store", () => {
  test("create/load/list/delete top-level and sub-sessions", async () => {
    const { store } = setup();
    const parent = await store.create({ alias: "main" });
    await expect(store.create({ alias: "main" })).rejects.toThrow(/alias/i);
    const child = await store.create({ parentSessionId: parent.id, childId: "review-A", agentName: "reviewer" });
    expect(child.id).toBe(`${parent.id}/review-A`);
    expect(await store.load(parent.id)).toMatchObject({ id: parent.id, harness: "h" });
    expect((await store.list()).map((s) => s.id)).toEqual([parent.id]);
    expect((await store.list({ includeChildren: true })).map((s) => s.id)).toEqual([parent.id, child.id]);
    await expect(store.delete(parent.id)).rejects.toThrow(/children/i);
    await store.delete(parent.id, { cascade: true });
    expect(await store.list({ includeChildren: true })).toEqual([]);
  });

  test("turn handle buffers, commits, rolls back, and enforces single-writer", async () => {
    const { store } = setup();
    const session = await store.create({});
    const h1 = store.beginTurn(session.id, "t1");
    h1.append({ role: "user", content: "hi" });
    expect(await store.getMessages(session.id)).toEqual([{ role: "user", content: "hi" }]);
    expect(() => store.beginTurn(session.id, "t2")).toThrow(/already/i);
    await h1.rollback();
    expect(await store.getMessages(session.id)).toEqual([]);
    const h2 = store.beginTurn(session.id, "t2");
    h2.append({ role: "assistant", content: "ok" });
    await h2.commit();
    await h2.rollback();
    expect(await store.getMessages(session.id)).toEqual([{ role: "assistant", content: "ok" }]);
  });

  test("event log append/read and public id validation", async () => {
    const { store } = setup();
    const session = await store.create({});
    await store.internalAppendEvent?.(session.id, 1, "turn:start", { turnId: "t", sessionId: session.id });
    const events = [];
    for await (const event of store.readEvents(session.id)) events.push(event);
    expect(events).toHaveLength(1);
    await expect(store.load("not-a-uuid")).rejects.toThrow(/top-level/i);
    expect(await store.exists("not-a-uuid")).toBe(false);
  });
});
