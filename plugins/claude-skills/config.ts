import type { FieldSchema } from "llm-contracts/public";
import type { ClaudeSkillsConfig } from "./public.d.ts";

export const DEFAULT_CONFIG: ClaudeSkillsConfig = Object.freeze({
  rescanIntervalMs: 30_000,
}) as ClaudeSkillsConfig;

// Plain Record over the config keys — compiles whether or not ConfigSchema<T>
// is generic in the contracts module.
export const CONFIG_SCHEMA: Record<keyof ClaudeSkillsConfig, FieldSchema> = {
  rescanIntervalMs: { type: "number", integer: true, min: 1 },
};
