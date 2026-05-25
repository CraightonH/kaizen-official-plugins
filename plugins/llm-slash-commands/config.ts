import type { FieldSchema } from "llm-contracts/public";
import type { SlashCommandsConfig } from "./public.d.ts";

export const DEFAULT_CONFIG: SlashCommandsConfig = Object.freeze({
  userDir: "~/.kaizen/commands",
  projectDir: ".kaizen/commands",
}) as SlashCommandsConfig;

// Plain Record over the SlashCommandsConfig keys so this compiles whether or
// not `ConfigSchema` is generic in the contracts module — matches llm-agents'
// precedent for user/project asset directories.
export const CONFIG_SCHEMA: Record<keyof SlashCommandsConfig, FieldSchema> = {
  userDir: { type: "string", min: 1 },
  projectDir: { type: "string", min: 1 },
};
