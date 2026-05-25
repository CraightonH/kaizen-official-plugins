import type { FieldSchema } from "llm-contracts/public";
import type { AgentsConfigFile } from "./public.d.ts";

export const DEFAULT_CONFIG: AgentsConfigFile = Object.freeze({
  maxDepth: 3,
  userDir: "~/.kaizen/agents",
  projectDir: ".kaizen/agents",
}) as AgentsConfigFile;

// Plain Record over the AgentsConfigFile keys so this compiles whether or
// not `ConfigSchema` is generic in the contracts module.
export const CONFIG_SCHEMA: Record<keyof AgentsConfigFile, FieldSchema> = {
  maxDepth: { type: "number", integer: true, min: 1 },
  userDir: { type: "string", min: 1 },
  projectDir: { type: "string", min: 1 },
};
