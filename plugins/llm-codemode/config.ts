import type { FieldSchema } from "llm-contracts/public";
import type { CodeModeConfig } from "./public.d.ts";

export const DEFAULT_CONFIG: CodeModeConfig = Object.freeze({
  timeoutMs: 30000,
  maxStdoutBytes: 16384,
  maxReturnBytes: 4096,
  sandbox: "bun-worker" as const,
}) as CodeModeConfig;

// Plain Record over the config keys — compiles whether or not
// ConfigSchema<T> is generic in the contracts module. Matches the
// canonical llm-axioms layout.
export const CONFIG_SCHEMA: Record<keyof CodeModeConfig, FieldSchema> = {
  timeoutMs: { type: "number", min: 1, integer: true },
  maxStdoutBytes: { type: "number", min: 1, integer: true },
  maxReturnBytes: { type: "number", min: 1, integer: true },
  sandbox: { type: "enum", values: ["bun-worker"] },
};
