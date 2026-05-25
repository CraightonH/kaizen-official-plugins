import type { FieldSchema } from "llm-contracts/public";
import type { LlmSystemPromptConfig } from "./public.d.ts";

export const DEFAULT_CONFIG: LlmSystemPromptConfig = Object.freeze({
  enabled: true,
  globalPath: "~/.kaizen/system-prompt.md",
  projectPath: "./.kaizen/system-prompt.md",
  projectHeader: "## Project context",
  fallbackPrefix:
    "You are a helpful assistant running locally via the kaizen local harness.",
}) as LlmSystemPromptConfig;

// Plain Record over the config keys so this compiles whether or not
// ConfigSchema<T> is generic in the contracts module — matches llm-axioms.
export const CONFIG_SCHEMA: Record<keyof LlmSystemPromptConfig, FieldSchema> = {
  enabled: { type: "boolean" },
  globalPath: { type: "string", min: 1 },
  projectPath: { type: "string", min: 1 },
  projectHeader: { type: "string" },
  fallbackPrefix: { type: "string", min: 1 },
};
