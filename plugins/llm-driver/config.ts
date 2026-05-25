import type { FieldSchema } from "llm-contracts/public";
import type { LlmDriverConfig } from "./public.d.ts";

export const DEFAULT_CONFIG: LlmDriverConfig = Object.freeze({
  defaultSystemPrompt: "",
}) as LlmDriverConfig;

// Plain Record over the config keys — compiles regardless of whether
// ConfigSchema<T> is generic in the contracts module.
export const CONFIG_SCHEMA: Record<keyof LlmDriverConfig, FieldSchema> = {
  defaultSystemPrompt: { type: "string" },
};
