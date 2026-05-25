import { homedir } from "node:os";
import { join } from "node:path";
import type { FieldSchema } from "llm-contracts/public";
import type { SessionManagerConfig } from "./public.d.ts";

// `sessionsBase` is fed directly into `mkdirSync` / `harnessRoot` — no tilde
// resolver downstream — so the default must be an already-absolute path.
// `kaizen-config` does not perform tilde expansion on string fields (verified
// against `kaizen-config/{store,schema,field-rendering}.ts`), so we resolve
// `homedir()` once at module load rather than emitting a literal `"~/..."`.
export const DEFAULT_CONFIG: SessionManagerConfig = Object.freeze({
  sessionsBase: join(homedir(), ".kaizen", "sessions"),
}) as SessionManagerConfig;

// Plain Record over the config keys — matches the canonical llm-axioms pattern.
export const CONFIG_SCHEMA: Record<keyof SessionManagerConfig, FieldSchema> = {
  sessionsBase: { type: "string", min: 1 },
};
