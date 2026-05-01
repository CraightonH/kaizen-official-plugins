import type { ChatMessage, LLMResponse } from "llm-events/public";

export interface CurrentTurn {
  id: string;
  controller: AbortController;
}

export function snapshotMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.slice();
}

export function aggregateUsage(
  usages: Array<LLMResponse["usage"]>,
): { promptTokens: number; completionTokens: number } {
  let p = 0;
  let c = 0;
  for (const u of usages) {
    if (!u) continue;
    p += u.promptTokens;
    c += u.completionTokens;
  }
  return { promptTokens: p, completionTokens: c };
}
