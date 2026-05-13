import type { LLMResponse, ToolSchema, ChatMessage } from "./llm-complete";

// Cardinality-one contract: exactly one provider (llm-native-dispatch OR llm-codemode,
// not both) is loaded per harness. Mutual exclusion enforced by manifest selection.

export interface ToolDispatchRegistry {
  invoke(
    name: string,
    args: unknown,
    ctx: {
      signal: AbortSignal;
      callId: string;
      turnId?: string;
      sessionId?: string;
      log: (msg: string) => void;
    },
  ): Promise<unknown>;
}

export interface ToolDispatchStrategy {
  prepareRequest(input: { availableTools: ToolSchema[] }):
    | { tools?: ToolSchema[]; systemPromptAppend?: string }
    | Promise<{ tools?: ToolSchema[]; systemPromptAppend?: string }>;
  handleResponse(input: {
    response: LLMResponse;
    registry: ToolDispatchRegistry;
    signal: AbortSignal;
    emit: (event: string, payload: unknown) => Promise<void>;
    turnId: string;
    sessionId: string;
  }): Promise<ChatMessage[]>;
}

export const CONTRACT_ID = "dispatch:strategy" as const;
export const DESCRIPTION = "Tool dispatch strategy — translates LLM tool calls into registry.invoke() sequences.";
