import type { FieldSchema, UiTheme } from "llm-contracts/public";
import type { LlmTuiConfig } from "./public.d.ts";
import { BUILT_IN_THEME, THEME_SCHEMA } from "./theme/schema.ts";

export type { LlmTuiConfig };

export const DEFAULT_CONFIG: LlmTuiConfig = Object.freeze({
  ...BUILT_IN_THEME,
  completionDebounceMs: 50,
  completionMaxVisible: 8,
  ctrlCExitWindowMs: 2000,
  thinkingTailLines: 5,
  agentActivityCap: 5,
  toolPreviewChars: 80,
  toolExpandedLineWidth: 200,
  toolExpandedPreviewLines: 10,
  toolFallbackJsonChars: 1500,
}) as LlmTuiConfig;

export const CONFIG_SCHEMA: Record<keyof LlmTuiConfig, FieldSchema> = {
  ...(THEME_SCHEMA as Record<keyof UiTheme, FieldSchema>),
  completionDebounceMs:     { type: "number", min: 0,   max: 2000,  integer: true },
  completionMaxVisible:     { type: "number", min: 1,   max: 32,    integer: true },
  ctrlCExitWindowMs:        { type: "number", min: 250, max: 10000, integer: true },
  thinkingTailLines:        { type: "number", min: 1,   max: 50,    integer: true },
  agentActivityCap:         { type: "number", min: 1,   max: 50,    integer: true },
  toolPreviewChars:         { type: "number", min: 20,  max: 500,   integer: true },
  toolExpandedLineWidth:    { type: "number", min: 40,  max: 1000,  integer: true },
  toolExpandedPreviewLines: { type: "number", min: 1,   max: 200,   integer: true },
  toolFallbackJsonChars:    { type: "number", min: 100, max: 50000, integer: true },
};
