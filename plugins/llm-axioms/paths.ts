import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

const DEFAULT_REL = ".kaizen/plugins/llm-axioms/sessions";

export function resolveAxiomsDir(opts: { home: string; configured?: string }): string {
  const c = (opts.configured ?? "").trim();
  if (c.length === 0) return join(opts.home, DEFAULT_REL);
  if (c.startsWith("~/")) return join(opts.home, c.slice(2));
  if (c === "~") return opts.home;
  return c;
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export function sessionFilePath(dir: string, sessionId: string): string {
  return join(dir, `${sessionId}.json`);
}

const TMP_RE = /\.tmp\.[^/]+$/;

export async function sweepStaleTempFiles(dir: string, staleMs: number): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return; // missing dir is fine
  }
  const cutoff = Date.now() - staleMs;
  for (const e of entries) {
    if (!TMP_RE.test(e)) continue;
    const full = join(dir, e);
    try {
      const st = await stat(full);
      if (st.mtimeMs < cutoff) {
        await unlink(full);
      }
    } catch {
      // best effort
    }
  }
}
