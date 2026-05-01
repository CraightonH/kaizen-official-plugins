import { readFile as fsReadFile } from "node:fs/promises";
import type { MemoryType } from "./public.d.ts";

export interface MemoryConfig {
  globalDir: string | null;          // null = unsupported (always set); typed for parity with projectDir.
  projectDir: string | null;         // null disables project layer
  injectionByteCap: number;
  autoExtract: boolean;
  extractTriggers: string[];
  denyTypes: MemoryType[];
  staleTempMs: number;               // sweeper threshold
}

const DEFAULT_TRIGGERS = [
  "from now on",
  "remember that",
  "always",
  "never",
  "i prefer",
  "my ",
];

export const DEFAULT_CONFIG: MemoryConfig = Object.freeze({
  globalDir: null,
  projectDir: null,
  injectionByteCap: 2048,
  autoExtract: false,
  extractTriggers: [...DEFAULT_TRIGGERS],
  denyTypes: [],
  staleTempMs: 60_000,
}) as MemoryConfig;

const VALID_TYPES = new Set<MemoryType>(["user", "feedback", "project", "reference"]);

export interface ConfigDeps {
  home: string;
  env: Record<string, string | undefined>;
  readFile: (path: string) => Promise<string>;
  log: (msg: string) => void;
}

export function defaultConfigPath(home: string): string {
  return `${home}/.kaizen/plugins/llm-memory/config.json`;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validate(cfg: MemoryConfig): void {
  if (cfg.injectionByteCap <= 0) throw new Error("llm-memory config: injectionByteCap must be > 0");
  if (cfg.staleTempMs < 0) throw new Error("llm-memory config: staleTempMs must be >= 0");
  for (const t of cfg.denyTypes) {
    if (!VALID_TYPES.has(t)) throw new Error(`llm-memory config: denyTypes contains unknown type "${t}"`);
  }
}

export async function loadConfig(deps: ConfigDeps): Promise<MemoryConfig> {
  const path = deps.env.KAIZEN_LLM_MEMORY_CONFIG ?? defaultConfigPath(deps.home);
  let raw: string | null = null;
  try {
    raw = await deps.readFile(path);
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      deps.log(`llm-memory: no config at ${path}; using defaults`);
      return { ...DEFAULT_CONFIG, extractTriggers: [...DEFAULT_CONFIG.extractTriggers], denyTypes: [] };
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`llm-memory config at ${path} malformed: ${(err as Error).message}`);
  }
  if (!isPlainObject(parsed)) throw new Error(`llm-memory config at ${path} must be a JSON object`);
  const merged: MemoryConfig = {
    ...DEFAULT_CONFIG,
    ...parsed,
    extractTriggers: Array.isArray((parsed as any).extractTriggers)
      ? (parsed as any).extractTriggers.map((s: unknown) => String(s).toLowerCase())
      : [...DEFAULT_CONFIG.extractTriggers],
    denyTypes: Array.isArray((parsed as any).denyTypes) ? (parsed as any).denyTypes : [],
  } as MemoryConfig;
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
