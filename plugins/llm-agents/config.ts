import { readFile as fsReadFile } from "node:fs/promises";
import { resolve, isAbsolute } from "node:path";

export interface AgentsConfigFile {
  maxDepth?: number;
  userDir?: string;
  projectDir?: string;
}

export interface AgentsConfig {
  maxDepth: number;
  resolvedUserDir: string;
  resolvedProjectDir: string;
}

export const DEFAULT_CONFIG = Object.freeze({
  maxDepth: 3,
  userDir: "~/.kaizen/agents",
  projectDir: ".kaizen/agents",
});

export interface ConfigDeps {
  home: string;
  cwd: string;
  env: Record<string, string | undefined>;
  readFile: (path: string) => Promise<string>;
  log: (msg: string) => void;
}

function defaultPath(home: string): string {
  return `${home}/.kaizen/plugins/llm-agents/config.json`;
}

function expandTilde(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return `${home}/${p.slice(2)}`;
  return p;
}

function resolveDir(p: string, home: string, cwd: string): string {
  const expanded = expandTilde(p, home);
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

export async function loadConfig(deps: ConfigDeps): Promise<AgentsConfig> {
  const userOverridePath = deps.env.KAIZEN_LLM_AGENTS_CONFIG;
  const path = userOverridePath ?? defaultPath(deps.home);
  let file: AgentsConfigFile = {};
  try {
    const raw = await deps.readFile(path);
    try { file = JSON.parse(raw) as AgentsConfigFile; }
    catch (err) { throw new Error(`llm-agents config at ${path} malformed: ${(err as Error).message}`); }
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      if (userOverridePath) deps.log(`llm-agents: KAIZEN_LLM_AGENTS_CONFIG=${path} not found; using defaults`);
    }
    else if (err?.message?.startsWith("llm-agents config")) throw err;
    else throw err;
  }

  const maxDepth = file.maxDepth ?? DEFAULT_CONFIG.maxDepth;
  if (!Number.isInteger(maxDepth) || maxDepth < 1) {
    throw new Error(`llm-agents config: maxDepth must be an integer >= 1`);
  }
  const userDir = file.userDir ?? DEFAULT_CONFIG.userDir;
  const projectDir = file.projectDir ?? DEFAULT_CONFIG.projectDir;
  return {
    maxDepth,
    resolvedUserDir: resolveDir(userDir, deps.home, deps.cwd),
    resolvedProjectDir: resolveDir(projectDir, deps.home, deps.cwd),
  };
}

export function realDeps(log: (msg: string) => void): ConfigDeps {
  return {
    home: process.env.HOME ?? "/",
    cwd: process.cwd(),
    env: process.env as Record<string, string | undefined>,
    readFile: (p) => fsReadFile(p, "utf8"),
    log,
  };
}
