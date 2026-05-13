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

  test("rename updates alias on snapshot, index, and emits session:renamed", async () => {
    const { store, emitted } = setup();
    const a = await store.create({ alias: "old-a" });
    const b = await store.create({ alias: "b" });
    const renamed = await store.rename(a.id, "new-a");
    expect(renamed.alias).toBe("new-a");
    // Persisted: the index reflects the new alias.
    expect((await store.list()).find((s) => s.id === a.id)?.alias).toBe("new-a");
    // Snapshot reload from disk reflects it too.
    expect((await store.load(a.id)).alias).toBe("new-a");
    // Collision under same parent rejects.
    await expect(store.rename(a.id, "b")).rejects.toThrow(/already in use/i);
    // Clear by passing null.
    const cleared = await store.rename(a.id, null);
    expect(cleared.alias).toBeUndefined();
    expect((await store.list()).find((s) => s.id === a.id)?.alias).toBeUndefined();
    expect(emitted.some((e) => e.event === "session:renamed")).toBe(true);
  });

  test("rename throws when the session does not exist", async () => {
    const { store } = setup();
    await expect(store.rename("00000000-0000-4000-8000-000000000999", "x")).rejects.toThrow(/not found/i);
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

  test("partialCommit: empty buffer behaves as rollback", async () => {
    const { store } = setup();
    const session = await store.create({});
    const h = store.beginTurn(session.id, "t1");
    await h.partialCommit();
    expect(await store.getMessages(session.id)).toEqual([]);
    // session should be writable again immediately (openTurn cleared)
    const h2 = store.beginTurn(session.id, "t2");
    h2.append({ role: "user", content: "next" });
    await h2.commit();
    expect(await store.getMessages(session.id)).toEqual([{ role: "user", content: "next" }]);
  });

  test("partialCommit: user-only buffer persists user message", async () => {
    const { store } = setup();
    const session = await store.create({});
    const h = store.beginTurn(session.id, "t1");
    h.append({ role: "user", content: "hello" });
    await h.partialCommit();
    expect(await store.getMessages(session.id)).toEqual([{ role: "user", content: "hello" }]);
  });

  test("partialCommit: drops trailing assistant with unresolved toolCalls", async () => {
    const { store } = setup();
    const session = await store.create({});
    const h = store.beginTurn(session.id, "t1");
    h.append({ role: "user", content: "list files" });
    h.append({
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call_1", name: "glob", arguments: {} }],
    });
    await h.partialCommit();
    expect(await store.getMessages(session.id)).toEqual([{ role: "user", content: "list files" }]);
  });

  test("partialCommit: keeps paired assistant+tool roundtrip", async () => {
    const { store } = setup();
    const session = await store.create({});
    const h = store.beginTurn(session.id, "t1");
    h.append({ role: "user", content: "list files" });
    h.append({
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call_1", name: "glob", arguments: {} }],
    });
    h.append({ role: "tool", content: "a.txt\nb.txt", toolCallId: "call_1" });
    h.append({ role: "tool", content: "", toolCallId: "call_1" }); // second tool result is fine; algorithm only checks last msg
    await h.partialCommit();
    const msgs = await store.getMessages(session.id);
    expect(msgs).toHaveLength(4);
    expect(msgs[msgs.length - 1]?.role).toBe("tool");
  });

  test("partialCommit: drops trailing assistant after a completed roundtrip", async () => {
    const { store } = setup();
    const session = await store.create({});
    const h = store.beginTurn(session.id, "t1");
    h.append({ role: "user", content: "list files" });
    h.append({
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call_1", name: "glob", arguments: {} }],
    });
    h.append({ role: "tool", content: "a.txt", toolCallId: "call_1" });
    h.append({
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call_2", name: "read", arguments: {} }],
    });
    await h.partialCommit();
    const msgs = await store.getMessages(session.id);
    expect(msgs).toHaveLength(3);
    expect(msgs[2]?.role).toBe("tool");
  });

  test("partialCommit: no-op after commit", async () => {
    const { store } = setup();
    const session = await store.create({});
    const h = store.beginTurn(session.id, "t1");
    h.append({ role: "user", content: "x" });
    await h.commit();
    await h.partialCommit(); // must not throw, must not double-write
    expect(await store.getMessages(session.id)).toEqual([{ role: "user", content: "x" }]);
  });

  test("partialCommit: no-op after rollback", async () => {
    const { store } = setup();
    const session = await store.create({});
    const h = store.beginTurn(session.id, "t1");
    h.append({ role: "user", content: "x" });
    await h.rollback();
    await h.partialCommit(); // must not throw
    expect(await store.getMessages(session.id)).toEqual([]);
  });
});
