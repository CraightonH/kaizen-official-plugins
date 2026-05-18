import type { TavilyConfig } from "./public.d.ts";

export const DEFAULT_CONFIG: TavilyConfig = Object.freeze({
  apiKey: "",
  endpoint: "https://api.tavily.com/search",
  defaultMaxResults: 5,
  defaultSearchDepth: "basic" as const,
  defaultIncludeAnswer: false,
  requestTimeoutMs: 30000,
});
