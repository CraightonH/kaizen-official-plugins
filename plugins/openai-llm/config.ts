import type { FieldSchema } from "llm-contracts/public";
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
}) as OpenAILLMConfig;

// Plain Record over the OpenAILLMConfig keys so this compiles regardless of
// whether ConfigSchema<T> is generic in the contracts module.
//
// `apiKey` is `secret: true` so config:store stores it via secrets:registry and
// only persists a `{ $ref: ... }` pointer on disk; `await cfgSvc.ready()`
// resolves the pointer to plaintext before the first `get()` in setup().
//
// NOTE: `apiKey` intentionally omits `min: 1` even though INTEGRATION.md's
// snippet shows it. The default is `""` because LM Studio (and other local
// OpenAI-compatible servers) accepts no key; combining `default: ""` with
// `min: 1` would fail validation on boot for unconfigured users and silently
// revert to defaults. Do not "fix" this by adding `min: 1`.
export const CONFIG_SCHEMA: Record<keyof OpenAILLMConfig, FieldSchema> = {
  baseUrl: { type: "string", min: 1 },
  apiKey: { type: "string", secret: true },
  defaultModel: { type: "string", min: 1 },
  defaultTemperature: { type: "number" },
  requestTimeoutMs: { type: "number", min: 1 },
  connectTimeoutMs: { type: "number", min: 1 },
  retry: {
    type: "object",
    properties: {
      maxAttempts: { type: "number", integer: true, min: 1 },
      initialDelayMs: { type: "number", min: 0 },
      maxDelayMs: { type: "number", min: 0 },
      jitter: { type: "enum", values: ["full", "none"] },
    },
  },
  extraHeaders: { type: "object", properties: {}, additionalProperties: { type: "string" } },
};
