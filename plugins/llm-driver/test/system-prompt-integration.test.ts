import { describe, expect, it, mock } from "bun:test";
import { runConversation, type RunConversationDeps } from "../loop.ts";
import type { ChatMessage } from "llm-events/public";
import type { SessionsStoreService, TurnHandle } from "llm-session-manager/public";

function makeSessions(): SessionsStoreService {
  let open: ChatMessage[] | null = null;
  const committed: ChatMessage[] = [];
  return {
    async create() { throw new Error("not needed"); },
    async load() { return {} as any; },
    async exists() { return true; },
    async getMessages() { return open ? [...committed, ...open] : committed.slice(); },
    beginTurn(_id: string, turnId: string): TurnHandle {
      if (open) throw new Error("already open");
      const buffer: ChatMessage[] = [];
      open = buffer;
      return {
        turnId,
        append: (m) => buffer.push(m),
        commit: async () => { committed.push(...buffer); open = null; },
        rollback: async () => { open = null; },
      };
    },
    async list() { return []; },
    async delete() {},
    async *readEvents() {},
  } as any;
}

function makeDeps(overrides: Partial<RunConversationDeps>): RunConversationDeps {
  const base: RunConversationDeps = {
    emit: mock(async () => {}),
    llmComplete: {
      complete: async function* () {
        yield { type: "done", response: { content: "ok", finishReason: "stop" } };
      },
      listModels: async () => [],
    } as any,
    registry: undefined,
    strategy: undefined,
    sessions: makeSessions(),
    log: () => {},
    idGen: () => "turn-1",
    defaultSystemPrompt: "",
  };
  return { ...base, ...overrides };
}

describe("driver — prompt:system consumption", () => {
  it("uses promptSystem.assemble() when promptSystem is provided in deps", async () => {
    const assembled = "ASSEMBLED-FROM-SERVICE";
    const promptSystem = {
      assemble: mock(async () => assembled),
      generation: () => 1,
      register: () => ({ unregister: () => {}, bumpGeneration: () => {} }),
      list: () => [],
    } as any;

    const captured: any[] = [];
    const deps = makeDeps({
      promptSystem,
      llmComplete: {
        complete: async function* (req: any) {
          captured.push(req.systemPrompt);
          yield { type: "done", response: { content: "x", finishReason: "stop" } };
        },
        listModels: async () => [],
      } as any,
    } as any);

    await runConversation(
      { systemPrompt: "", sessionId: "session-1", userMessage: { role: "user", content: "hi" } },
      deps,
    );

    expect(captured[0]).toBe(assembled);
    expect(promptSystem.assemble).toHaveBeenCalled();
  });

  it("caches assembly across turns when generation is unchanged", async () => {
    let gen = 1;
    let assembleCalls = 0;
    const promptSystem = {
      assemble: async () => { assembleCalls++; return "X"; },
      generation: () => gen,
      register: () => ({ unregister: () => {}, bumpGeneration: () => {} }),
      list: () => [],
    } as any;

    const deps = makeDeps({ promptSystem } as any);
    await runConversation({ systemPrompt: "", sessionId: "session-1", userMessage: { role: "user", content: "1" } }, deps);
    await runConversation({ systemPrompt: "", sessionId: "session-1", userMessage: { role: "user", content: "2" } }, deps);

    expect(assembleCalls).toBe(1);
  });

  it("re-assembles when generation increments", async () => {
    let gen = 1;
    let assembleCalls = 0;
    const promptSystem = {
      assemble: async () => { assembleCalls++; return `gen-${gen}`; },
      generation: () => gen,
      register: () => ({ unregister: () => {}, bumpGeneration: () => {} }),
      list: () => [],
    } as any;

    const deps = makeDeps({ promptSystem } as any);
    await runConversation({ systemPrompt: "", sessionId: "session-1", userMessage: { role: "user", content: "1" } }, deps);
    gen = 2;
    await runConversation({ systemPrompt: "", sessionId: "session-1", userMessage: { role: "user", content: "2" } }, deps);

    expect(assembleCalls).toBe(2);
  });

  it("falls back to legacy systemPromptAppend path when promptSystem is undefined", async () => {
    const captured: any[] = [];
    const deps = makeDeps({
      strategy: {
        prepareRequest: () => ({ systemPromptAppend: "STRATEGY-APPEND" }),
        handleResponse: async () => [],
      } as any,
      llmComplete: {
        complete: async function* (req: any) {
          captured.push(req.systemPrompt);
          yield { type: "done", response: { content: "x", finishReason: "stop" } };
        },
        listModels: async () => [],
      } as any,
    });

    await runConversation(
      { systemPrompt: "BASE", sessionId: "session-1", userMessage: { role: "user", content: "hi" } },
      deps,
    );

    expect(captured[0]).toContain("BASE");
    expect(captured[0]).toContain("STRATEGY-APPEND");
  });
});
