import type { FieldSchema } from "llm-contracts/public";
import type { AxiomsConfig } from "./public.d.ts";

export const DEFAULT_CONFIG: AxiomsConfig = Object.freeze({
  axiomsDir: "~/.kaizen/plugins/llm-axioms/sessions",
  injectionByteCap: 4096,
  methodologyEnabled: true,
  workspaceEnabled: true,
  staleTempMs: 60_000,
}) as AxiomsConfig;

// Use a plain Record over the AxiomsConfig keys so this compiles whether or
// not `ConfigSchema` is generic in the contracts module — matches llm-memory's
// inline-object precedent.
export const CONFIG_SCHEMA: Record<keyof AxiomsConfig, FieldSchema> = {
  axiomsDir: { type: "string" },
  injectionByteCap: { type: "number", min: 0 },
  methodologyEnabled: { type: "boolean" },
  workspaceEnabled: { type: "boolean" },
  staleTempMs: { type: "number", min: 0 },
};
