import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

export interface ResolveDirsInput {
  home: string;
  cwd: string;
  config: { globalDir?: string | null; projectDir?: string | null };
}

export interface ResolvedDirs {
  globalDir: string;
  projectDir: string | null;
}

function expandHome(home: string, p: string): string {
  if (p.startsWith("~/")) return join(home, p.slice(2));
  if (p === "~") return home;
  return p;
}

export function resolveDirs(input: ResolveDirsInput): ResolvedDirs {
  const { home, cwd, config } = input;
  const global =
    config.globalDir === undefined || config.globalDir === null
      ? join(home, ".kaizen", "memory")
      : expandHome(home, config.globalDir);
  let project: string | null;
  if (config.projectDir === null) {
    project = null;
  } else if (config.projectDir === undefined) {
    project = join(cwd, ".kaizen", "memory");
  } else {
    project = expandHome(home, config.projectDir);
  }
  return { globalDir: global, projectDir: project };
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function listMemoryFiles(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err: any) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
  return entries.filter(
    (e) => e.endsWith(".md") && e !== "MEMORY.md" && !e.startsWith("."),
  );
}

export async function sweepStaleTempFiles(dir: string, thresholdMs: number): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const now = Date.now();
  const removed: string[] = [];
  for (const e of entries) {
    if (!e.includes(".tmp.")) continue;
    const full = join(dir, e);
    try {
      const st = await stat(full);
      if (now - st.mtimeMs >= thresholdMs) {
        await unlink(full);
        removed.push(full);
      }
    } catch {
      // ignore
    }
  }
  return removed;
}
