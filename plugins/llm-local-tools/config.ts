// plugins/llm-local-tools/config.ts
import type { FieldSchema } from "llm-contracts/public";
import type { LlmLocalToolsConfig } from "./public.d.ts";

export const DEFAULT_CONFIG: LlmLocalToolsConfig = Object.freeze({
  readMaxBytes: 50 * 1024 * 1024,
  readCapBytes: 256 * 1024,
  readCapLines: 2000,
  bashOutputCap: 256 * 1024,
  bashDefaultTimeoutMs: 120_000,
  grepDefaultMax: 200,
  globCap: 1000,
  webFetchCapBytes: 512 * 1024,
  webFetchDownloadCapBytes: 50 * 1024 * 1024,
  webFetchDefaultTimeoutMs: 30_000,
}) as LlmLocalToolsConfig;

// Plain Record over the config keys so this compiles regardless of how
// ConfigSchema<T> is parameterized in the contracts module.
export const CONFIG_SCHEMA: Record<keyof LlmLocalToolsConfig, FieldSchema> = {
  readMaxBytes:             { type: "number", min: 1024, integer: true },
  readCapBytes:             { type: "number", min: 1024, integer: true },
  readCapLines:             { type: "number", min: 1,    integer: true },
  bashOutputCap:            { type: "number", min: 1024, integer: true },
  bashDefaultTimeoutMs:     { type: "number", min: 1000, max: 600_000, integer: true },
  grepDefaultMax:           { type: "number", min: 1,    integer: true },
  globCap:                  { type: "number", min: 1,    integer: true },
  webFetchCapBytes:         { type: "number", min: 1024, integer: true },
  webFetchDownloadCapBytes: { type: "number", min: 1024, integer: true },
  webFetchDefaultTimeoutMs: { type: "number", min: 1000, max: 120_000, integer: true },
};
