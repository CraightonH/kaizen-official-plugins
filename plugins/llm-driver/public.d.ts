export type {
  ChatMessage,
  ToolCall,
  ToolSchema,
  LLMRequest,
  LLMResponse,
  LLMStreamEvent,
  LLMCompleteService,
} from "llm-events/public";

import type { ChatMessage, LLMResponse, ToolSchema } from "llm-events/public";
import type { TurnHandle } from "llm-session-manager/public";

// Owned by llm-driver: service contract for `driver:run-conversation`.
export type RunConversationInput = {
  systemPrompt: string;
  sessionId: string;
  toolFilter?: { tags?: string[]; names?: string[] };
  model?: string;
  parentTurnId?: string;
  signal?: AbortSignal;
  trigger?: "user" | "agent";
} & (
  | {
      externalTurnId: string;
      turnHandle: TurnHandle;
      userMessage?: never;
    }
  | {
      /**
       * The user message to append before inference. When omitted (and the call
       * owns the turn), runConversation infers against the current snapshot tail —
       * which must already end with a user turn (e.g. one seeded by session:handoff).
       */
      userMessage?: ChatMessage;
      externalTurnId?: never;
      turnHandle?: never;
    }
);

export interface RunConversationOutput {
  finalMessage: ChatMessage;
  usage: { promptTokens: number; completionTokens: number };
}

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

export interface DriverService {
  runConversation(input: RunConversationInput): Promise<RunConversationOutput>;
}
