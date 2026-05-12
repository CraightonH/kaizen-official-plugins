import { readFile as fsReadFile } from "node:fs/promises";

export interface OpenAILLMConfig {
  baseUrl: string;
  apiKey: string;
  apiKeyEnv?: string;
  defaultModel: string;
  defaultTemperature: number;
  requestTimeoutMs: number;
  connectTimeoutMs: number;
  retry: {
    maxAttempts: number;
    initialDelayMs: number;
    maxDelayMs: number;
    jitter: "full" | "none";
  };
  extraHeaders: Record<string, string>;
}

export const DEFAULT_CONFIG: OpenAILLMConfig = Object.freeze({
  baseUrl: "http://localhost:1234/v1",
  apiKey: "",
  defaultModel: "local-model",
  defaultTemperature: 0.7,
  requestTimeoutMs: 120000,
  connectTimeoutMs: 10000,
  retry: { maxAttempts: 3, initialDelayMs: 500, maxDelayMs: 8000, jitter: "full" as const },
  extraHeaders: {},
});

export interface ConfigDeps {
  home: string;
  env: Record<string, string | undefined>;
  readFile: (path: string) => Promise<string>;
  log: (msg: string) => void;
}

export function defaultConfigPath(home: string): string {
  return `${home}/.kaizen/plugins/openai-llm/config.json`;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validate(cfg: OpenAILLMConfig): void {
  if (!cfg.baseUrl || typeof cfg.baseUrl !== "string") throw new Error("openai-llm config: baseUrl required");
  try { new URL(cfg.baseUrl); } catch { throw new Error("openai-llm config: baseUrl must be a valid URL"); }
  if (typeof cfg.apiKey !== "string") throw new Error("openai-llm config: apiKey must be a string");
  if (cfg.apiKeyEnv !== undefined && typeof cfg.apiKeyEnv !== "string") throw new Error("openai-llm config: apiKeyEnv must be a string");
  if (!cfg.defaultModel || typeof cfg.defaultModel !== "string") throw new Error("openai-llm config: defaultModel required");
  if (typeof cfg.defaultTemperature !== "number" || !Number.isFinite(cfg.defaultTemperature)) throw new Error("openai-llm config: defaultTemperature must be a finite number");
  if (typeof cfg.requestTimeoutMs !== "number" || !Number.isFinite(cfg.requestTimeoutMs) || cfg.requestTimeoutMs <= 0) throw new Error("openai-llm config: requestTimeoutMs must be > 0");
  if (typeof cfg.connectTimeoutMs !== "number" || !Number.isFinite(cfg.connectTimeoutMs) || cfg.connectTimeoutMs <= 0) throw new Error("openai-llm config: connectTimeoutMs must be > 0");
  if (typeof cfg.retry.maxAttempts !== "number" || !Number.isInteger(cfg.retry.maxAttempts) || cfg.retry.maxAttempts < 1) throw new Error("openai-llm config: retry.maxAttempts must be an integer >= 1");
  if (typeof cfg.retry.initialDelayMs !== "number" || !Number.isFinite(cfg.retry.initialDelayMs) || cfg.retry.initialDelayMs < 0) throw new Error("openai-llm config: retry.initialDelayMs must be >= 0");
  if (typeof cfg.retry.maxDelayMs !== "number" || !Number.isFinite(cfg.retry.maxDelayMs) || cfg.retry.maxDelayMs < cfg.retry.initialDelayMs) throw new Error("openai-llm config: retry.maxDelayMs < initialDelayMs");
  if (cfg.retry.jitter !== "full" && cfg.retry.jitter !== "none") throw new Error("openai-llm config: retry.jitter must be 'full' or 'none'");
  for (const [key, value] of Object.entries(cfg.extraHeaders)) {
    if (typeof value !== "string") throw new Error(`openai-llm config: extraHeaders.${key} must be a string`);
  }
}

export async function loadConfig(deps: ConfigDeps): Promise<OpenAILLMConfig> {
  const userOverridePath = deps.env.KAIZEN_OPENAI_LLM_CONFIG;
  const path = userOverridePath ?? defaultConfigPath(deps.home);
  let raw: string | null = null;
  try {
    raw = await deps.readFile(path);
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      if (userOverridePath) {
        deps.log(`openai-llm: KAIZEN_OPENAI_LLM_CONFIG=${path} not found; using defaults`);
      }
      return { ...DEFAULT_CONFIG, retry: { ...DEFAULT_CONFIG.retry }, extraHeaders: {} };
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`openai-llm config at ${path} malformed: ${(err as Error).message}`);
  }
  if (!isPlainObject(parsed)) throw new Error(`openai-llm config at ${path} must be a JSON object`);
  if (parsed.retry !== undefined && !isPlainObject(parsed.retry)) throw new Error(`openai-llm config at ${path}: retry must be a JSON object`);
  if (parsed.extraHeaders !== undefined && !isPlainObject(parsed.extraHeaders)) throw new Error(`openai-llm config at ${path}: extraHeaders must be a JSON object`);

  const merged: OpenAILLMConfig = {
    ...DEFAULT_CONFIG,
    ...parsed,
    retry: { ...DEFAULT_CONFIG.retry, ...((parsed as any).retry ?? {}) },
    extraHeaders: { ...((parsed as any).extraHeaders ?? {}) },
  } as OpenAILLMConfig;

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
