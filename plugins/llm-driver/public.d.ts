export type {
  ChatMessage,
  ToolCall,
  ToolSchema,
  LLMRequest,
  LLMResponse,
  LLMStreamEvent,
  LLMCompleteService,
  ToolDispatchStrategy,
  ToolDispatchRegistry,
  DriverService,
  RunConversationInput,
  RunConversationOutput,
  TurnHandle,
} from "llm-contracts/public";

// Plugin-private config shape consumed via config:store.
export interface LlmDriverConfig {
  /**
   * Fallback system prompt used by the interactive loop when prompt:registry
   * is not bound. Default: "".
   */
  defaultSystemPrompt: string;
}
