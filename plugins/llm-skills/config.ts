import type { FieldSchema } from "llm-contracts/public";
import type { LlmSkillsConfig } from "./public.d.ts";

export const DEFAULT_CONFIG: LlmSkillsConfig = Object.freeze({
  userRoot: "~/.kaizen/skills",
  rescanIntervalMs: 30_000,
}) as LlmSkillsConfig;

// Plain Record over the config keys — compiles whether or not
// ConfigSchema<T> is generic in the contracts module. The schema is
// shape-only; the "never 0" rescan-interval invariant is enforced as a
// post-`get()` runtime clamp in index.ts (see CLAUDE.md).
export const CONFIG_SCHEMA: Record<keyof LlmSkillsConfig, FieldSchema> = {
  userRoot: { type: "string", min: 1 },
  rescanIntervalMs: { type: "number", min: 0, integer: true },
};
