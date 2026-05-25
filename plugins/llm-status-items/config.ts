import type { FieldSchema } from "llm-contracts/public";
import type { LlmStatusItemsConfig } from "./public.d.ts";

export const DEFAULT_CONFIG: LlmStatusItemsConfig = Object.freeze({
  costRates: {},
  costDecimalPlaces: 4,
  contextBarWidth: 10,
  contextBarFillGlyph: "█",
  contextBarEmptyGlyph: "░",
  tokensPerSecIntegerThreshold: 10,
  slashCommandEnabled: true,
  toolEnabled: true,
}) as LlmStatusItemsConfig;

// Plain Record over the config keys — compiles whether or not
// ConfigSchema<T> is generic in the contracts module.
export const CONFIG_SCHEMA: Record<keyof LlmStatusItemsConfig, FieldSchema> = {
  costRates: {
    type: "object",
    properties: {},
    additionalProperties: {
      type: "object",
      properties: {
        promptCentsPerMTok: { type: "number", min: 0 },
        completionCentsPerMTok: { type: "number", min: 0 },
      },
      additionalProperties: false,
    },
  },
  costDecimalPlaces: { type: "number", min: 0, max: 8, integer: true },
  contextBarWidth: { type: "number", min: 1, max: 40, integer: true },
  contextBarFillGlyph: { type: "string", min: 1, max: 4 },
  contextBarEmptyGlyph: { type: "string", min: 1, max: 4 },
  tokensPerSecIntegerThreshold: { type: "number", min: 0 },
  slashCommandEnabled: { type: "boolean" },
  toolEnabled: { type: "boolean" },
};
