import { readFile as fsReadFile } from "node:fs/promises";

export interface CodeModeConfig {
  timeoutMs: number;
  maxStdoutBytes: number;
  maxReturnBytes: number;
  maxBlocksPerResponse: number;
  sandbox: "bun-worker";
}

export const DEFAULT_CONFIG: CodeModeConfig = Object.freeze({
  timeoutMs: 30000,
  maxStdoutBytes: 16384,
  maxReturnBytes: 4096,
  maxBlocksPerResponse: 8,
  sandbox: "bun-worker" as const,
});

export interface ConfigDeps {
  home: string;
  env: Record<string, string | undefined>;
  readFile: (path: string) => Promise<string>;
  log: (m: string) => void;
}

export function defaultConfigPath(home: string): string {
  return `${home}/.kaizen/plugins/llm-codemode-dispatch/config.json`;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validate(cfg: CodeModeConfig): void {
  if (cfg.timeoutMs <= 0) throw new Error("llm-codemode-dispatch: timeoutMs must be > 0");
  if (cfg.maxStdoutBytes <= 0) throw new Error("llm-codemode-dispatch: maxStdoutBytes must be > 0");
  if (cfg.maxReturnBytes <= 0) throw new Error("llm-codemode-dispatch: maxReturnBytes must be > 0");
  if (cfg.maxBlocksPerResponse <= 0) throw new Error("llm-codemode-dispatch: maxBlocksPerResponse must be > 0");
  if (cfg.sandbox !== "bun-worker") throw new Error("llm-codemode-dispatch: sandbox must be 'bun-worker'");
}

export async function loadConfig(deps: ConfigDeps): Promise<CodeModeConfig> {
  const path = deps.env.KAIZEN_LLM_CODEMODE_CONFIG ?? defaultConfigPath(deps.home);
  let raw: string;
  try {
    raw = await deps.readFile(path);
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      deps.log(`llm-codemode-dispatch: no config at ${path}; using defaults`);
      return { ...DEFAULT_CONFIG };
    }
    throw err;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch (err) {
    throw new Error(`llm-codemode-dispatch config at ${path} malformed: ${(err as Error).message}`);
  }
  if (!isPlainObject(parsed)) throw new Error(`llm-codemode-dispatch config at ${path} must be a JSON object`);
  const merged: CodeModeConfig = { ...DEFAULT_CONFIG, ...(parsed as object) } as CodeModeConfig;
  validate(merged);
  return merged;
}

export function realDeps(log: (m: string) => void): ConfigDeps {
  return {
    home: process.env.HOME ?? "/",
    env: process.env as Record<string, string | undefined>,
    readFile: (p) => fsReadFile(p, "utf8"),
    log,
  };
}
