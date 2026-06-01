// Shared fakes used across unit + integration tests.
import type { DriverService, RunConversationInput, RunConversationOutput, ChatMessage } from "llm-contracts/public";

export function fakeDriver(opts: {
  reply?: (input: RunConversationInput) => Promise<RunConversationOutput>;
} = {}): { driver: DriverService; calls: RunConversationInput[] } {
  const calls: RunConversationInput[] = [];
  const driver: DriverService = {
    async runConversation(input) {
      calls.push(input);
      if (opts.reply) return opts.reply(input);
      const msg: ChatMessage = { role: "assistant", content: `ok:${input.userMessage && "content" in input.userMessage ? input.userMessage.content : ""}` };
      return { finalMessage: msg, usage: { promptTokens: 10, completionTokens: 5 } };
    },
  };
  return { driver, calls };
}

export function counter() {
  let n = 0;
  return { next: () => ++n, peek: () => n };
}

export interface EventCapture {
  on: (name: string, fn: (p: unknown) => void) => void;
  emit: (name: string, p: unknown) => void;
  emitted: Array<{ name: string; payload: unknown }>;
}
export function eventBus(): EventCapture {
  const subs = new Map<string, Array<(p: unknown) => void>>();
  const emitted: Array<{ name: string; payload: unknown }> = [];
  return {
    on(name, fn) {
      const list = subs.get(name) ?? [];
      list.push(fn); subs.set(name, list);
    },
    emit(name, p) {
      emitted.push({ name, payload: p });
      for (const fn of subs.get(name) ?? []) fn(p);
    },
    emitted,
  };
}
