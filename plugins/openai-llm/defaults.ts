import type { OpenAILLMConfig } from "./public.d.ts";

export const DEFAULT_CONFIG: OpenAILLMConfig = Object.freeze({
  baseUrl: "http://localhost:1234/v1",
  apiKey: "",
  defaultModel: "local-model",
  defaultTemperature: 0.7,
  requestTimeoutMs: 120000,
  connectTimeoutMs: 10000,
  retry: { maxAttempts: 3, initialDelayMs: 500, maxDelayMs: 8000, jitter: "full" as const },
  extraHeaders: {},
});
