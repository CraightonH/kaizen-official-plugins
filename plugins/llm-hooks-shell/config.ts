import type { FieldSchema } from "llm-contracts/public";
import type { HooksConfig } from "./public";

export const DEFAULT_CONFIG: HooksConfig = Object.freeze({
  hooks: [],
  defaultTimeoutMs: 30_000,
  depthCap: 4,
}) as HooksConfig;

// Use a plain Record over the HooksConfig keys so this compiles whether or
// not `ConfigSchema` is generic in the contracts module — matches llm-axioms.
export const CONFIG_SCHEMA: Record<keyof HooksConfig, FieldSchema> = {
  hooks: {
    type: "array",
    items: {
      type: "object",
      properties: {
        event: { type: "string", min: 1 },
        command: { type: "string", min: 1 },
        cwd: { type: "string" },
        block_on_nonzero: { type: "boolean" },
        timeout_ms: { type: "number", min: 1 },
      },
      additionalProperties: true,
    },
  },
  defaultTimeoutMs: { type: "number", min: 1, integer: true },
  depthCap: { type: "number", min: 1, integer: true },
};
