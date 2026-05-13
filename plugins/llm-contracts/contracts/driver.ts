import type { ChatMessage, TurnHandle } from "../public";

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

export interface DriverService {
  runConversation(input: RunConversationInput): Promise<RunConversationOutput>;
}

export const CONTRACT_ID = "driver:run-conversation" as const;
export const DESCRIPTION = "Conversation driver — runs one LLM-mediated turn including tool dispatch and session handoff.";
