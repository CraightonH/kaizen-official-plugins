// Public types for the openai-llm plugin.
//
// These are plugin-internal contract types — not exported into
// `llm-contracts`. Other plugins should not import from here.

export interface OpenAILLMConfig {
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  defaultTemperature: number;
  requestTimeoutMs: number;
  connectTimeoutMs: number;
  retry: {
    maxAttempts: number;
    initialDelayMs: number;
    maxDelayMs: number;
    jitter: "full" | "none";
  };
  extraHeaders: Record<string, string>;
}
