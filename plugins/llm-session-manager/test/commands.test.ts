import { describe, it, expect, mock } from "bun:test";
import { makeCommands } from "../commands.ts";
import type { SessionsStoreService, SessionRecord } from "../store.ts";

function fakeStore(overrides: Partial<SessionsStoreService> = {}): SessionsStoreService {
  return {
    create: mock(async () => ({ id: "new-id", harness: "h", metadata: {}, createdAt: 0, pluginFingerprint: [] } as SessionRecord)),
    load: mock(async () => { throw new Error("not impl"); }),
    exists: mock(async () => false),
    getMessages: mock(async () => []),
    beginTurn: mock((id: string, turnId: string) => ({ turnId, append: () => {}, commit: async () => {}, rollback: async () => {} })),
    list: mock(async () => []),
    rename: mock(async (id, alias) => ({ id, alias: alias ?? undefined, harness: "h", metadata: {}, createdAt: 0, pluginFingerprint: [] } as SessionRecord)),
    delete: mock(async () => {}),
    readEvents: mock(() => (async function* () {})()),
    ...overrides,
  };
}

function captureEmit() {
  const calls: Array<{ event: string; payload: any }> = [];
  return {
    calls,
    emit: async (event: string, payload: unknown) => { calls.push({ event, payload: payload as any }); return []; },
  };
}

describe("clearSession", () => {
  it("creates a new session and emits both session:active-changed and conversation:cleared", async () => {
    const store = fakeStore({
      create: mock(async () => ({ id: "sess-2", alias: "happy-otter", harness: "h", metadata: {}, createdAt: 0, pluginFingerprint: [] } as SessionRecord)),
    });
    const bus = captureEmit();
    const cmds = makeCommands({ store, emit: bus.emit, getActiveSessionId: () => "sess-1" });

    const result = await cmds.clearSession();

    expect(result).toEqual({ from: "sess-1", to: "sess-2", alias: "happy-otter", seeded: false });
    expect(bus.calls).toEqual([
      { event: "session:active-changed", payload: { from: "sess-1", to: "sess-2", alias: "happy-otter" } },
      { event: "conversation:cleared", payload: { from: "sess-1", to: "sess-2" } },
    ]);
  });

  it("handles null active session", async () => {
    const store = fakeStore({
      create: mock(async () => ({ id: "sess-1", harness: "h", metadata: {}, createdAt: 0, pluginFingerprint: [] } as SessionRecord)),
    });
    const bus = captureEmit();
    const cmds = makeCommands({ store, emit: bus.emit, getActiveSessionId: () => null });
    const result = await cmds.clearSession();
    expect(result.from).toBe(null);
    expect(result.alias).toBe(null);
  });
});

function fakeStoreCapturingMessages() {
  const messages: any[] = [];
  const store = fakeStore({
    create: mock(async () => ({ id: "new-id", harness: "h", metadata: {}, createdAt: 0, pluginFingerprint: [] } as SessionRecord)),
    beginTurn: mock((_id: string, turnId: string) => ({
      turnId,
      append: (m: any) => { messages.push(m); },
      commit: async () => {},
      rollback: async () => {},
    })),
  });
  return { store, messages };
}

describe("clearSession validation", () => {
  it("no prompt, no autostart: backward-compat (no handoff event)", async () => {
    const store = fakeStore({
      create: mock(async () => ({ id: "sess-2", harness: "h", metadata: {}, createdAt: 0, pluginFingerprint: [] } as SessionRecord)),
    });
    const bus = captureEmit();
    const cmds = makeCommands({ store, emit: bus.emit, getActiveSessionId: () => "sess-1" });
    await cmds.clearSession();
    const events = bus.calls.map((c) => c.event);
    expect(events).toContain("session:active-changed");
    expect(events).not.toContain("session:handoff");
  });

  it("prompt + autostart=true: emits handoff with autostart=true", async () => {
    const store = fakeStore({
      create: mock(async () => ({ id: "sess-2", harness: "h", metadata: {}, createdAt: 0, pluginFingerprint: [] } as SessionRecord)),
    });
    const bus = captureEmit();
    const cmds = makeCommands({ store, emit: bus.emit, getActiveSessionId: () => "sess-1" });
    await cmds.clearSession({ prompt: "continue work", autostart: true });
    const handoff = bus.calls.find((c) => c.event === "session:handoff");
    expect(handoff).toBeDefined();
    expect(handoff!.payload).toEqual({ from: "sess-1", to: "sess-2", prompt: "continue work", autostart: true });
  });

  it("prompt only: defaults autostart to true", async () => {
    const store = fakeStore({
      create: mock(async () => ({ id: "sess-2", harness: "h", metadata: {}, createdAt: 0, pluginFingerprint: [] } as SessionRecord)),
    });
    const bus = captureEmit();
    const cmds = makeCommands({ store, emit: bus.emit, getActiveSessionId: () => "sess-1" });
    await cmds.clearSession({ prompt: "go" });
    const handoff = bus.calls.find((c) => c.event === "session:handoff");
    expect(handoff).toBeDefined();
    expect(handoff!.payload.autostart).toBe(true);
  });

  it("prompt + autostart=false: emits handoff with autostart=false", async () => {
    const store = fakeStore({
      create: mock(async () => ({ id: "sess-2", harness: "h", metadata: {}, createdAt: 0, pluginFingerprint: [] } as SessionRecord)),
    });
    const bus = captureEmit();
    const cmds = makeCommands({ store, emit: bus.emit, getActiveSessionId: () => "sess-1" });
    await cmds.clearSession({ prompt: "go", autostart: false });
    const handoff = bus.calls.find((c) => c.event === "session:handoff");
    expect(handoff).toBeDefined();
    expect(handoff!.payload.autostart).toBe(false);
  });

  it("autostart=true with no prompt: rejects", async () => {
    const cmds = makeCommands({ store: fakeStore(), emit: async () => [], getActiveSessionId: () => "sess-1" });
    await expect(cmds.clearSession({ autostart: true } as any)).rejects.toThrow(/prompt/i);
  });

  it("autostart=false with no prompt: rejects", async () => {
    const cmds = makeCommands({ store: fakeStore(), emit: async () => [], getActiveSessionId: () => "sess-1" });
    await expect(cmds.clearSession({ autostart: false } as any)).rejects.toThrow(/prompt/i);
  });

  it("empty/whitespace prompt: rejects", async () => {
    const cmds = makeCommands({ store: fakeStore(), emit: async () => [], getActiveSessionId: () => "sess-1" });
    await expect(cmds.clearSession({ prompt: "   " })).rejects.toThrow(/non-empty/i);
  });

  it("active session is a child session: rejects handoff", async () => {
    const cmds = makeCommands({ store: fakeStore(), emit: async () => [], getActiveSessionId: () => "parent/child" });
    await expect(cmds.clearSession({ prompt: "x" })).rejects.toThrow(/top-level/i);
  });

  it("seeded user turn lands in new snapshot with meta.handoff.from", async () => {
    const { store, messages } = fakeStoreCapturingMessages();
    const bus = captureEmit();
    const cmds = makeCommands({ store, emit: bus.emit, getActiveSessionId: () => "old-id" });
    await cmds.clearSession({ prompt: "resume here" });
    expect(messages.length).toBe(1);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toBe("resume here");
    expect(messages[0].meta.handoff.from).toBe("old-id");
  });

  it("event ordering: active-changed fires before handoff", async () => {
    const store = fakeStore({
      create: mock(async () => ({ id: "sess-2", harness: "h", metadata: {}, createdAt: 0, pluginFingerprint: [] } as SessionRecord)),
    });
    const bus = captureEmit();
    const cmds = makeCommands({ store, emit: bus.emit, getActiveSessionId: () => "sess-1" });
    await cmds.clearSession({ prompt: "go" });
    const events = bus.calls.map((c) => c.event);
    const idxActive = events.indexOf("session:active-changed");
    const idxHandoff = events.indexOf("session:handoff");
    expect(idxActive).toBeGreaterThanOrEqual(0);
    expect(idxHandoff).toBeGreaterThan(idxActive);
  });
});

describe("listSessions", () => {
  it("delegates to store.list with includeChildren", async () => {
    const rows: SessionRecord[] = [{ id: "s1", harness: "h", metadata: {}, createdAt: 0, pluginFingerprint: [] }];
    const store = fakeStore({ list: mock(async () => rows) });
    const cmds = makeCommands({ store, emit: async () => [], getActiveSessionId: () => null });
    const out = await cmds.listSessions({ includeChildren: true });
    expect(out).toBe(rows);
    expect((store.list as any).mock.calls[0][0]).toEqual({ includeChildren: true });
  });

  it("defaults includeChildren to false", async () => {
    const store = fakeStore({ list: mock(async () => []) });
    const cmds = makeCommands({ store, emit: async () => [], getActiveSessionId: () => null });
    await cmds.listSessions({});
    expect((store.list as any).mock.calls[0][0]).toEqual({ includeChildren: false });
  });
});

describe("resumeSession", () => {
  it("resolves by id when session exists", async () => {
    const rec: SessionRecord = { id: "s1", alias: "fox", harness: "h", metadata: {}, createdAt: 0, pluginFingerprint: [] };
    const store = fakeStore({
      exists: mock(async (id) => id === "s1"),
      load: mock(async () => rec),
    });
    const bus = captureEmit();
    const cmds = makeCommands({ store, emit: bus.emit, getActiveSessionId: () => "old" });
    const out = await cmds.resumeSession({ id_or_alias: "s1" });
    expect(out).toEqual({ id: "s1", alias: "fox" });
    expect(bus.calls.map((c) => c.event)).toEqual(["session:active-changed", "session:resumed"]);
    expect(bus.calls[0].payload).toEqual({ from: "old", to: "s1", alias: "fox" });
    expect(bus.calls[1].payload).toEqual({ id: "s1" });
  });

  it("resolves by alias when id miss", async () => {
    const rec: SessionRecord = { id: "s2", alias: "owl", harness: "h", metadata: {}, createdAt: 0, pluginFingerprint: [] };
    const store = fakeStore({
      exists: mock(async () => false),
      list: mock(async () => [rec]),
    });
    const cmds = makeCommands({ store, emit: async () => [], getActiveSessionId: () => null });
    const out = await cmds.resumeSession({ id_or_alias: "owl" });
    expect(out).toEqual({ id: "s2", alias: "owl" });
  });

  it("throws when token resolves to nothing", async () => {
    const store = fakeStore({ exists: mock(async () => false), list: mock(async () => []) });
    const cmds = makeCommands({ store, emit: async () => [], getActiveSessionId: () => null });
    await expect(cmds.resumeSession({ id_or_alias: "nope" })).rejects.toThrow(/session not found: nope/);
  });

  it("throws on empty token", async () => {
    const cmds = makeCommands({ store: fakeStore(), emit: async () => [], getActiveSessionId: () => null });
    await expect(cmds.resumeSession({ id_or_alias: "" })).rejects.toThrow(/missing session id/);
  });
});

describe("renameActiveSession", () => {
  it("renames when active session set", async () => {
    const store = fakeStore({
      rename: mock(async (id, alias) => ({ id, alias: alias!, harness: "h", metadata: {}, createdAt: 0, pluginFingerprint: [] })),
    });
    const cmds = makeCommands({ store, emit: async () => [], getActiveSessionId: () => "active" });
    const out = await cmds.renameActiveSession({ name: "new-name" });
    expect(out).toEqual({ id: "active", alias: "new-name" });
    expect((store.rename as any).mock.calls[0]).toEqual(["active", "new-name"]);
  });

  it("throws when no active session", async () => {
    const cmds = makeCommands({ store: fakeStore(), emit: async () => [], getActiveSessionId: () => null });
    await expect(cmds.renameActiveSession({ name: "x" })).rejects.toThrow(/no active session/i);
  });

  it("throws on empty name", async () => {
    const cmds = makeCommands({ store: fakeStore(), emit: async () => [], getActiveSessionId: () => "active" });
    await expect(cmds.renameActiveSession({ name: "" })).rejects.toThrow(/name is required/i);
  });
});

describe("deleteSession", () => {
  it("deletes a non-active session", async () => {
    const store = fakeStore();
    const cmds = makeCommands({ store, emit: async () => [], getActiveSessionId: () => "active" });
    const out = await cmds.deleteSession({ id: "other", cascade: false });
    expect(out).toEqual({ deleted: "other" });
    expect((store.delete as any).mock.calls[0]).toEqual(["other", { cascade: false }]);
  });

  it("requires --cascade when active session has children", async () => {
    const store = fakeStore({
      list: mock(async () => [
        { id: "active", harness: "h", metadata: {}, createdAt: 0, pluginFingerprint: [] },
        { id: "active/child", harness: "h", metadata: {}, createdAt: 0, pluginFingerprint: [] },
      ]),
    });
    const cmds = makeCommands({ store, emit: async () => [], getActiveSessionId: () => "active" });
    await expect(cmds.deleteSession({ id: "active", cascade: false })).rejects.toThrow(/cascade/);
  });

  it("creates a replacement when deleting active session", async () => {
    const newRec: SessionRecord = { id: "replacement", alias: "fresh-cat", harness: "h", metadata: {}, createdAt: 0, pluginFingerprint: [] };
    const store = fakeStore({
      list: mock(async () => [{ id: "active", harness: "h", metadata: {}, createdAt: 0, pluginFingerprint: [] }]),
      create: mock(async () => newRec),
    });
    const bus = captureEmit();
    const cmds = makeCommands({ store, emit: bus.emit, getActiveSessionId: () => "active" });
    const out = await cmds.deleteSession({ id: "active", cascade: false });
    expect(out).toEqual({ deleted: "active", replacement: "replacement" });
    expect(bus.calls[0]).toEqual({ event: "session:active-changed", payload: { from: "active", to: "replacement", alias: "fresh-cat" } });
  });

  it("rolls back replacement if delete throws", async () => {
    const newRec: SessionRecord = { id: "replacement", harness: "h", metadata: {}, createdAt: 0, pluginFingerprint: [] };
    const deleted: string[] = [];
    const store = fakeStore({
      list: mock(async () => [{ id: "active", harness: "h", metadata: {}, createdAt: 0, pluginFingerprint: [] }]),
      create: mock(async () => newRec),
      delete: mock(async (id: string) => {
        deleted.push(id);
        if (id === "active") throw new Error("disk-full");
      }),
    });
    const cmds = makeCommands({ store, emit: async () => [], getActiveSessionId: () => "active" });
    await expect(cmds.deleteSession({ id: "active", cascade: false })).rejects.toThrow(/disk-full/);
    expect(deleted).toEqual(["active", "replacement"]);
  });

  it("throws on missing id", async () => {
    const cmds = makeCommands({ store: fakeStore(), emit: async () => [], getActiveSessionId: () => null });
    await expect(cmds.deleteSession({ id: "", cascade: false })).rejects.toThrow(/missing session id/);
  });
});
