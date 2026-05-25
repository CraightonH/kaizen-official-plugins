import type { FieldSchema } from "llm-contracts/public";
import type { MemoryConfig } from "./public.d.ts";

export const DEFAULT_CONFIG: MemoryConfig = Object.freeze({
  globalDir: null,
  projectDir: null,
  injectionByteCap: 2048,
  autoExtract: false,
  extractTriggers: ["from now on", "remember that", "always", "never", "i prefer", "my "],
  denyTypes: [],
  staleTempMs: 60_000,
}) as MemoryConfig;

// Plain Record over the MemoryConfig keys — compiles whether or not
// ConfigSchema<T> is generic in the contracts module. Mirrors llm-axioms.
//
// `globalDir` / `projectDir` are intentionally omitted: their declared type is
// `string | null`, which the current FieldSchema union cannot express. The
// store stores them as-is without validation; runtime tolerance for null lives
// in `resolveDirs` (paths.ts). See docs/config-migration/PLAN-llm-memory.md.
export const CONFIG_SCHEMA: Partial<Record<keyof MemoryConfig, FieldSchema>> = {
  injectionByteCap: { type: "number", min: 0 },
  autoExtract: { type: "boolean" },
  extractTriggers: { type: "array", items: { type: "string" } },
  denyTypes: { type: "array", items: { type: "enum", values: ["user", "feedback", "project", "reference"] } },
  staleTempMs: { type: "number", min: 0 },
};
