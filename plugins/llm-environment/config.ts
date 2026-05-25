import type { FieldSchema } from "llm-contracts/public";
import type { LlmEnvironmentConfig } from "./public.d.ts";

export const DEFAULT_CONFIG: LlmEnvironmentConfig = Object.freeze({
  enabled: true,
}) as LlmEnvironmentConfig;

// Plain Record over the LlmEnvironmentConfig keys — compiles whether or not
// ConfigSchema<T> is generic in the contracts module.
export const CONFIG_SCHEMA: Record<keyof LlmEnvironmentConfig, FieldSchema> = {
  enabled: { type: "boolean" },
};
