import { readFile as fsReadFile } from "node:fs/promises";
import { homedir } from "node:os";

export interface HookEntry {
  event: string;
  command: string;
  cwd?: string;
  block_on_nonzero?: boolean;
  timeout_ms?: number;
  env?: Record<string, string>;
  /** Internal: file source for diagnostics. */
  _source?: "home" | "project";
}

export interface ConfigDeps {
  home: string;
  cwd: string;
  readFile: (path: string) => Promise<string>;
}

export function realConfigDeps(): ConfigDeps {
  return {
    home: homedir(),
    cwd: process.cwd(),
    readFile: (p) => fsReadFile(p, "utf8"),
  };
}

export const MUTABLE_EVENTS: ReadonlySet<string> = new Set([
  "llm:before-call",
  "tool:before-execute",
  "codemode:before-execute",
]);

const HOME_REL = ".kaizen/hooks/hooks.json";
const PROJECT_REL = ".kaizen/hooks/hooks.json";

async function readMaybe(deps: ConfigDeps, path: string): Promise<string | null> {
  try {
    return await deps.readFile(path);
  } catch (e: any) {
    if (e?.code === "ENOENT") return null;
    throw e;
  }
}

function parseFile(path: string, text: string): HookEntry[] {
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`llm-hooks-shell: config at ${path} is malformed JSON: ${(e as Error).message}`);
  }
  const hooks = parsed?.hooks;
  if (!Array.isArray(hooks)) {
    throw new Error(`llm-hooks-shell: config at ${path} must have a "hooks" array`);
  }
  for (const h of hooks) {
    if (typeof h?.event !== "string" || h.event.length === 0) {
      throw new Error(`llm-hooks-shell: config at ${path} has an entry missing "event": ${JSON.stringify(h)}`);
    }
    if (typeof h?.command !== "string" || h.command.length === 0) {
      throw new Error(`llm-hooks-shell: config at ${path} has an entry missing "command": ${JSON.stringify(h)}`);
    }
  }
  return hooks as HookEntry[];
}

export interface LoadResult {
  entries: HookEntry[];
  warnings: string[];
}

export async function loadHookConfigs(deps: ConfigDeps, vocab: ReadonlySet<string>): Promise<LoadResult> {
  const homePath = `${deps.home}/${HOME_REL}`;
  const projectPath = `${deps.cwd}/${PROJECT_REL}`;

  const homeText = await readMaybe(deps, homePath);
  const projectText = await readMaybe(deps, projectPath);

  const home = homeText ? parseFile(homePath, homeText).map(e => ({ ...e, _source: "home" as const })) : [];
  const project = projectText ? parseFile(projectPath, projectText).map(e => ({ ...e, _source: "project" as const })) : [];
  const entries = [...home, ...project];

  const warnings: string[] = [];
  for (const e of entries) {
    if (!vocab.has(e.event)) {
      throw new Error(`llm-hooks-shell: unknown event "${e.event}" in entry: ${JSON.stringify(e)}`);
    }
    if (e.block_on_nonzero && !MUTABLE_EVENTS.has(e.event)) {
      warnings.push(`llm-hooks-shell: block_on_nonzero is ignored on non-mutable event "${e.event}" (entry: ${e.command})`);
    }
  }
  return { entries, warnings };
}
