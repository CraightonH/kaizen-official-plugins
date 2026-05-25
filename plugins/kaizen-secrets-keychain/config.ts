import type { FieldSchema } from "llm-contracts/public";
import type { KaizenSecretsKeychainConfig } from "./public.d.ts";

export const DEFAULT_CONFIG: KaizenSecretsKeychainConfig = Object.freeze({
  keychainService: "kaizen-secrets",
}) as KaizenSecretsKeychainConfig;

// Plain Record over the config keys — compiles whether or not
// ConfigSchema<T> is generic in the contracts module.
export const CONFIG_SCHEMA: Record<keyof KaizenSecretsKeychainConfig, FieldSchema> = {
  keychainService: { type: "string", min: 1, max: 255 },
};
