import { describe, it, expect, mock } from "bun:test";
import { registerSlashCommands } from "../slash.ts";
import { registerToolCommands } from "../tools.ts";
import { makeCommands } from "../commands.ts";
import type { SessionsStoreService, SessionRecord } from "llm-contracts/public";

function fakeStore(rec: SessionRecord): SessionsStoreService {
  return {
    create: mock(async () => rec),
    load: mock(async () => rec),
    exists: mock(async () => true),
    getMessages: mock(async () => []),
    beginTurn: mock((id: string, turnId: string) => ({ turnId, append: () => {}, commit: async () => {}, rollback: async () => {}, partialCommit: async () => {} })),
    list: mock(async () => [rec]),
    rename: mock(async (id, alias) => ({ ...rec, id, alias: alias ?? undefined })),
    delete: mock(async () => {}),
    readEvents: mock(() => (async function* () {})()),
  };
}

describe("slash and tool adapters produce equivalent service side-effects", () => {
  it("clearSession: /session:new slash and session:new tool both call store.create exactly once and emit the same events", async () => {
    const rec: SessionRecord = { id: "fresh", alias: "ant", harness: "h", metadata: {}, createdAt: 0, pluginFingerprint: [] };

    async function run(register: (cmds: ReturnType<typeof makeCommands>) => Promise<void>) {
      const store = fakeStore(rec);
      const events: Array<{ event: string; payload: any }> = [];
      const cmds = makeCommands({
        store,
        emit: async (event, payload) => { events.push({ event, payload: payload as any }); return []; },
        getActiveSessionId: () => "old",
      });
      await register(cmds);
      return { store, events };
    }

    const slashRun = await run(async (cmds) => {
      const registered: Array<{ m: any; h: (ctx: any) => Promise<void> }> = [];
      registerSlashCommands({ register: (m, h) => { registered.push({ m, h }); return () => {}; } }, cmds);
      await registered.find((r) => r.m.name === "session:new")!.h({ args: "", print: async () => {} });
    });

    const toolRun = await run(async (cmds) => {
      const registered: Array<{ s: any; h: (args: any, ctx: any) => Promise<unknown> }> = [];
      registerToolCommands({ register: (s, h) => { registered.push({ s, h }); return () => {}; } }, cmds);
      await registered.find((r) => r.s.name === "session:new")!.h({}, { signal: new AbortController().signal, callId: "c", log: () => {} });
    });

    expect((slashRun.store.create as any).mock.calls.length).toBe(1);
    expect((toolRun.store.create as any).mock.calls.length).toBe(1);
    expect(slashRun.events).toEqual(toolRun.events);
  });
});
