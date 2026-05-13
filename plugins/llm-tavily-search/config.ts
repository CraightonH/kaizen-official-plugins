// plugins/llm-tavily-search/config.ts
import { readFile as fsReadFile } from "node:fs/promises";

export interface TavilyConfig {
  apiKey: string;
  apiKeyEnv?: string;
  endpoint: string;
  defaultMaxResults: number;
  defaultSearchDepth: "basic" | "advanced";
  defaultIncludeAnswer: boolean;
  requestTimeoutMs: number;
}

export const DEFAULT_CONFIG: TavilyConfig = Object.freeze({
  apiKey: "",
  apiKeyEnv: "TAVILY_API_KEY",
  endpoint: "https://api.tavily.com/search",
  defaultMaxResults: 5,
  defaultSearchDepth: "basic" as const,
  defaultIncludeAnswer: false,
  requestTimeoutMs: 30000,
});

export interface ConfigDeps {
  home: string;
  env: Record<string, string | undefined>;
  readFile: (path: string) => Promise<string>;
  log: (msg: string) => void;
}

export function defaultConfigPath(home: string): string {
  return `${home}/.kaizen/plugins/llm-tavily-search/config.json`;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validate(cfg: TavilyConfig): void {
  if (!cfg.endpoint) throw new Error("llm-tavily-search config: endpoint required");
  if (cfg.defaultMaxResults < 1 || cfg.defaultMaxResults > 20) throw new Error("llm-tavily-search config: defaultMaxResults must be 1..20");
  if (cfg.requestTimeoutMs <= 0) throw new Error("llm-tavily-search config: requestTimeoutMs must be > 0");
  if (cfg.defaultSearchDepth !== "basic" && cfg.defaultSearchDepth !== "advanced") {
    throw new Error("llm-tavily-search config: defaultSearchDepth must be 'basic' or 'advanced'");
  }
}

export async function loadConfig(deps: ConfigDeps): Promise<TavilyConfig> {
  const override = deps.env.KAIZEN_TAVILY_CONFIG;
  const path = override ?? defaultConfigPath(deps.home);
  let raw: string | null = null;
  try {
    raw = await deps.readFile(path);
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === "ENOENT") {
      if (override) deps.log(`llm-tavily-search: KAIZEN_TAVILY_CONFIG=${path} not found; using defaults`);
      const merged = { ...DEFAULT_CONFIG };
      if (merged.apiKeyEnv) {
        const v = deps.env[merged.apiKeyEnv];
        if (typeof v === "string" && v.length > 0) merged.apiKey = v;
      }
      validate(merged);
      return merged;
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`llm-tavily-search config at ${path} malformed: ${(err as Error).message}`);
  }
  if (!isPlainObject(parsed)) throw new Error(`llm-tavily-search config at ${path} must be a JSON object`);

  const merged: TavilyConfig = { ...DEFAULT_CONFIG, ...parsed } as TavilyConfig;
  if (merged.apiKeyEnv) {
    const v = deps.env[merged.apiKeyEnv];
    if (typeof v === "string" && v.length > 0) merged.apiKey = v;
  }
  validate(merged);
  return merged;
}

export function realDeps(log: (msg: string) => void): ConfigDeps {
  return {
    home: process.env.HOME ?? "/",
    env: process.env as Record<string, string | undefined>,
    readFile: (p) => fsReadFile(p, "utf8"),
    log,
  };
}
