import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export interface ScannedFile {
  /** Path-derived skill name. Equal to the immediate subdirectory of the scan root. */
  relativeName: string;
  /** Absolute path to the SKILL.md file. */
  absolutePath: string;
  /** Absolute path to the skill's directory (parent of SKILL.md). Surfaced via SkillManifest.baseDir. */
  baseDir: string;
  /** Verbatim contents of SKILL.md (frontmatter + body). */
  body: string;
}

/**
 * Walk `<absRoot>/<name>/SKILL.md` entries (one level deep). Returns [] if the
 * root does not exist or is not a directory. Each entry's `relativeName` is the
 * `<name>` segment. Sibling files inside the skill directory are ignored.
 * Nested directories (e.g. `<absRoot>/group/name/SKILL.md`) are not scanned.
 */
export async function scanRoot(absRoot: string): Promise<ScannedFile[]> {
  let rootStat;
  try {
    rootStat = await stat(absRoot);
  } catch {
    return [];
  }
  if (!rootStat.isDirectory()) return [];

  let entries;
  try {
    entries = await readdir(absRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const out: ScannedFile[] = [];
  for (const ent of entries) {
    if (ent.name.startsWith(".")) continue;
    // Accept directories and symlinks (which may resolve to directories).
    if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
    const baseDir = join(absRoot, ent.name);
    const skillFile = join(baseDir, "SKILL.md");
    let body: string;
    try {
      body = await readFile(skillFile, "utf8");
    } catch {
      // Missing SKILL.md, unreadable, or symlink target isn't a dir → skip silently.
      continue;
    }
    out.push({
      relativeName: ent.name,
      absolutePath: skillFile,
      baseDir,
      body,
    });
  }

  out.sort((a, b) => a.relativeName.localeCompare(b.relativeName));
  return out;
}
