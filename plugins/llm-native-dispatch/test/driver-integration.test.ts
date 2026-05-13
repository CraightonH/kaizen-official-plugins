import { test, expect } from "bun:test";
import { runConversation, type RunConversationDeps } from "../../llm-driver/loop.ts";
import { makeStrategy } from "../strategy.ts";
import type { ChatMessage, ToolSchema } from "llm-contracts/public";

function makeFakeServices() {
  const messages: ChatMessage[] = [];
  const sessions = {
    beginTurn: () => ({
      append: (m: ChatMessage) => { messages.push(m); },
      commit: async () => {},
      rollback: async () => {},
    }),
    getMessages: async () => [...messages],
  };
  return { sessions, messages };
}

test("native dispatch + driver does not duplicate the assistant message", async () => {
  const { sessions, messages } = makeFakeServices();
  const tool: ToolSchema = { name: "echo", description: "", parameters: { type: "object" } };

  let callIdx = 0;
  const llmComplete = {
    async *complete() {
      if (callIdx === 0) {
        callIdx++;
        yield { type: "done" as const, response: {
          content: "I'll echo.",
          toolCalls: [{ id: "c1", name: "echo", arguments: { msg: "hi" } }],
          finishReason: "tool_calls" as const,
        }};
      } else {
        yield { type: "done" as const, response: {
          content: "Done.",
          finishReason: "stop" as const,
        }};
      }
    },
    async listModels() { return []; },
  };

  const registry = {
    list: () => [tool],
    invoke: async () => "hi back",
  };

  const deps: RunConversationDeps = {
    emit: async () => {},
    llmComplete,
    registry: registry as any,
    strategy: makeStrategy(),
    sessions: sessions as any,
    log: () => {},
    idGen: () => "turn-1",
    defaultSystemPrompt: "",
  };

  await runConversation(
    { sessionId: "s1", systemPrompt: "", userMessage: { role: "user", content: "echo hi" } },
    deps,
  );

  const assistants = messages.filter((m) => m.role === "assistant");
  expect(assistants).toHaveLength(2);
  expect(assistants[0]?.toolCalls?.[0]?.name).toBe("echo");
  const roles = messages.map((m) => m.role);
  expect(roles).toEqual(["user", "assistant", "tool", "assistant"]);
});
