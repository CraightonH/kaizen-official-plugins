import type { FieldSchema } from "llm-contracts/public";
import type { TavilyConfig } from "./public.d.ts";

export const DEFAULT_CONFIG: TavilyConfig = Object.freeze({
  apiKey: "",
  endpoint: "https://api.tavily.com/search",
  defaultMaxResults: 5,
  defaultSearchDepth: "basic" as const,
  defaultIncludeAnswer: false,
  requestTimeoutMs: 30000,
}) as TavilyConfig;

// Use a plain Record over the TavilyConfig keys so this compiles whether or
// not `ConfigSchema` is generic in the contracts module — matches the
// llm-axioms precedent.
export const CONFIG_SCHEMA: Record<keyof TavilyConfig, FieldSchema> = {
  apiKey: { type: "string", secret: true, min: 1 },
  endpoint: { type: "string", min: 1 },
  defaultMaxResults: { type: "number", integer: true, min: 1, max: 20 },
  defaultSearchDepth: { type: "enum", values: ["basic", "advanced"] },
  defaultIncludeAnswer: { type: "boolean" },
  requestTimeoutMs: { type: "number", min: 1 },
};
