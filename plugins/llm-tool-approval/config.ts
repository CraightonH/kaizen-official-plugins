import type { FieldSchema } from "llm-contracts/public";
import type { ToolApprovalConfig } from "./public.d.ts";
import defaultsRaw from "./defaults.json" with { type: "json" };

export const DEFAULT_CONFIG: ToolApprovalConfig = Object.freeze({
  allow: Array.isArray((defaultsRaw as { allow?: unknown }).allow)
    ? ((defaultsRaw as { allow: unknown[] }).allow.filter((s): s is string => typeof s === "string"))
    : [],
  deny: Array.isArray((defaultsRaw as { deny?: unknown }).deny)
    ? ((defaultsRaw as { deny: unknown[] }).deny.filter((s): s is string => typeof s === "string"))
    : [],
}) as ToolApprovalConfig;

// Plain Record over the config keys — compiles whether or not
// ConfigSchema<T> is generic in the contracts module.
export const CONFIG_SCHEMA: Record<keyof ToolApprovalConfig, FieldSchema> = {
  allow: { type: "array", items: { type: "string" } },
  deny: { type: "array", items: { type: "string" } },
};
