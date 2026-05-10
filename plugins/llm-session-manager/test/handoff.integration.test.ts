import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeStore } from "../store";
import { makeCommands } from "../commands";

describe("session:handoff integration", () => {
  test("archive -> seed -> switch -> handoff event, in order", async () => {
    const sessionsBase = mkdtempSync(join(tmpdir(), "sm-handoff-"));
    const events: { event: string; payload: any; t: number }[] = [];
    let counter = 0;
    const store = makeStore({
      sessionsBase,
      harnessKey: "test",
      pluginFingerprint: ["test@0"],
      now: () => ++counter,
      newUuid: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`,
      log: () => {},
      emit: async (event, payload) => {
        events.push({ event, payload, t: ++counter });
        return [];
      },
    });

    const initial = await store.create({});
    let activeId: string | null = initial.id;
    const cmds = makeCommands({
      store,
      emit: async (event, payload) => {
        events.push({ event, payload, t: ++counter });
        return [];
      },
      getActiveSessionId: () => activeId,
    });

    // Reset event log to focus on handoff sequence (drop initial create).
    events.length = 0;

    const result = await cmds.clearSession({ prompt: "carry on", autostart: true });
    activeId = result.to;

    // Snapshot of new session contains the seeded user message with meta.
    const messages = await store.getMessages(result.to);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toBe("carry on");
    expect((messages[0] as any).meta?.handoff?.from).toBe(initial.id);

    // Event order: session:created (new) -> session:active-changed -> conversation:cleared -> session:handoff
    const names = events.map((e) => e.event);
    const created = names.lastIndexOf("session:created");
    const ac = names.lastIndexOf("session:active-changed");
    const cleared = names.lastIndexOf("conversation:cleared");
    const ho = names.lastIndexOf("session:handoff");
    expect(created).toBeGreaterThan(-1);
    expect(ac).toBeGreaterThan(created);
    expect(cleared).toBeGreaterThan(ac);
    expect(ho).toBeGreaterThan(cleared);

    const handoff = events[ho];
    expect(handoff.payload).toEqual({
      from: initial.id,
      to: result.to,
      prompt: "carry on",
      autostart: true,
    });
  });

  test("autostart=false fires handoff with autostart=false", async () => {
    const sessionsBase = mkdtempSync(join(tmpdir(), "sm-handoff-"));
    const events: { event: string; payload: any }[] = [];
    let counter = 0;
    const store = makeStore({
      sessionsBase,
      harnessKey: "test",
      pluginFingerprint: ["test@0"],
      now: () => ++counter,
      newUuid: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`,
      log: () => {},
      emit: async (event, payload) => {
        events.push({ event, payload });
        return [];
      },
    });
    const initial = await store.create({});
    let activeId: string | null = initial.id;
    const cmds = makeCommands({
      store,
      emit: async (event, payload) => {
        events.push({ event, payload });
        return [];
      },
      getActiveSessionId: () => activeId,
    });
    await cmds.clearSession({ prompt: "draft this", autostart: false });
    const ho = events.find((e) => e.event === "session:handoff");
    expect(ho).toBeDefined();
    expect((ho!.payload as any).autostart).toBe(false);
    expect((ho!.payload as any).from).toBe(initial.id);
  });
});
