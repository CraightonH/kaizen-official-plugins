import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ConfigFile {
  allow: string[];
  deny: string[];
}

const EMPTY: ConfigFile = { allow: [], deny: [] };

export function loadSource(path: string, log?: (msg: string) => void): ConfigFile {
  if (!existsSync(path)) return { allow: [], deny: [] };
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    log?.(`llm-tool-approval: failed to read ${path}: ${(err as Error).message}`);
    return { allow: [], deny: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log?.(`llm-tool-approval: malformed JSON at ${path}: ${(err as Error).message}`);
    return { allow: [], deny: [] };
  }
  const allow = Array.isArray((parsed as any)?.allow) ? ((parsed as any).allow as unknown[]).filter((x): x is string => typeof x === "string") : [];
  const deny = Array.isArray((parsed as any)?.deny) ? ((parsed as any).deny as unknown[]).filter((x): x is string => typeof x === "string") : [];
  return { allow, deny };
}

export function mergeRules(sources: ReadonlyArray<ConfigFile>): ConfigFile {
  const allow = new Set<string>();
  const deny = new Set<string>();
  for (const s of sources) {
    for (const a of s.allow) allow.add(a);
    for (const d of s.deny) deny.add(d);
  }
  return { allow: [...allow], deny: [...deny] };
}

export function pickWriteTarget(env: { cwd: string; home: string }): string {
  const projectKaizen = join(env.cwd, ".kaizen");
  if (existsSync(projectKaizen)) {
    return join(projectKaizen, "plugins", "llm-tool-approval", "config.json");
  }
  return join(env.home, ".kaizen", "plugins", "llm-tool-approval", "config.json");
}

/**
 * Appends `entry` to the `allow` list at `path`. Creates the file (and parent
 * dirs) if missing. Dedupes + sorts entries on write. Atomic via tmp+rename.
 * Throws on disk failure; the caller decides the foreground behavior.
 */
export function appendAllowAtomic(path: string, entry: string): void {
  const current = existsSync(path) ? loadSource(path) : { ...EMPTY };
  const next: ConfigFile = {
    allow: dedupeSort([...current.allow, entry]),
    deny: dedupeSort(current.deny),
  };
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

function dedupeSort(arr: string[]): string[] {
  return [...new Set(arr)].sort();
}
