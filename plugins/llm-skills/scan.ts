import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export interface ScannedFile {
  relativeName: string;   // path-derived skill name; '/'-separated; no .md suffix
  absolutePath: string;
  body: string;
}

export async function scanRoot(absRoot: string): Promise<ScannedFile[]> {
  let rootStat;
  try {
    rootStat = await stat(absRoot);
  } catch {
    return [];
  }
  if (!rootStat.isDirectory()) return [];

  const out: ScannedFile[] = [];
  const visited = new Set<string>();   // realpath-based dir cycle guard (best-effort)

  async function walk(dir: string): Promise<void> {
    if (visited.has(dir)) return;
    visited.add(dir);

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name.startsWith(".")) continue;        // skip dotfiles + dotdirs
      const abs = join(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(abs);
      } else if (ent.isFile() || ent.isSymbolicLink()) {
        if (!ent.name.endsWith(".md")) continue;
        let body: string;
        try {
          body = await readFile(abs, "utf8");
        } catch {
          continue;
        }
        const rel = relative(absRoot, abs).split(sep).join("/");
        const relativeName = rel.slice(0, -".md".length);
        out.push({ relativeName, absolutePath: abs, body });
      }
    }
  }

  await walk(absRoot);
  // Stable order regardless of OS readdir order.
  out.sort((a, b) => a.relativeName.localeCompare(b.relativeName));
  return out;
}
