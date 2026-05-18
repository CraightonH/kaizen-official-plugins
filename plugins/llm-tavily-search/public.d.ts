// llm-tavily-search registers a single tool. Its only public surface is the
// LLM-facing tool name. Consumers wiring the harness should not need to import
// from this plugin; the canonical shared tool types are re-exported here for
// convenience and are owned by llm-events / llm-tools-registry.

export type { ToolSchema } from "llm-tools-registry/public";

export const TOOL_NAMES: readonly ["web_search"];

export interface TavilyConfig {
  apiKey: string;
  endpoint: string;
  defaultMaxResults: number;
  defaultSearchDepth: "basic" | "advanced";
  defaultIncludeAnswer: boolean;
  requestTimeoutMs: number;
}
