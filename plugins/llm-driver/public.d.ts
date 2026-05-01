export type {
  ChatMessage,
  ToolCall,
  ToolSchema,
  LLMRequest,
  LLMResponse,
  LLMStreamEvent,
  LLMCompleteService,
} from "llm-events/public";

import type { ChatMessage } from "llm-events/public";

export interface RunConversationInput {
  systemPrompt: string;
  messages: ChatMessage[];
  toolFilter?: { tags?: string[]; names?: string[] };
  model?: string;
  parentTurnId?: string;
  signal?: AbortSignal;
}

export interface RunConversationOutput {
  finalMessage: ChatMessage;
  messages: ChatMessage[];
  usage: { promptTokens: number; completionTokens: number };
}

export interface DriverService {
  runConversation(input: RunConversationInput): Promise<RunConversationOutput>;
}
