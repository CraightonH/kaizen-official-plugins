import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseFrontmatter } from "./frontmatter.ts";

export type SkillLayer = "project" | "user" | "plugin-cache";

export interface ScannedSkill {
  name: string;             // e.g. "proj-only" or "plug-a:cached-a"
  description: string;
  tokens?: number;          // explicit tokens from frontmatter, if present
  baseDir: string;          // absolute realpath of the directory containing SKILL.md
  body: string;             // raw SKILL.md body (post-frontmatter)
  layer: SkillLayer;
  sourcePath: string;       // absolute path to SKILL.md
}

export interface ScanRootsConfig {
  projectRoot?: string;
  userRoot?: string;
  pluginCacheRoot?: string;
}

export interface ScanHooks {
  onError: (msg: string) => void;
  log: (msg: string) => void;
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

async function listDirs(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries
      .filter(e => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith("."))
      .map(e => e.name);
  } catch { return []; }
}

async function readSkillDir(
  skillDir: string,
  name: string,
  layer: SkillLayer,
  hooks: ScanHooks,
): Promise<ScannedSkill | undefined> {
  const skillMd = join(skillDir, "SKILL.md");
  if (!(await exists(skillMd))) return undefined;
  let real: string;
  try { real = await realpath(skillDir); }
  catch (e) {
    hooks.onError(`[claude-skills] realpath failed for ${skillDir}: ${(e as Error).message}`);
    return undefined;
  }
  let text: string;
  try { text = await readFile(skillMd, "utf8"); }
  catch (e) {
    hooks.onError(`[claude-skills] read failed for ${skillMd}: ${(e as Error).message}`);
    return undefined;
  }
  const parsed = parseFrontmatter(text);
  if (!parsed.ok) {
    hooks.onError(`[claude-skills] frontmatter error in ${skillMd}: ${parsed.error}`);
    return undefined;
  }
  return {
    name,
    description: parsed.manifest.description,
    tokens: parsed.manifest.tokens,
    baseDir: real,
    body: parsed.body,
    layer,
    sourcePath: skillMd,
  };
}

async function scanFlatRoot(
  root: string,
  layer: "project" | "user",
  hooks: ScanHooks,
): Promise<ScannedSkill[]> {
  if (!(await exists(root))) return [];
  const out: ScannedSkill[] = [];
  for (const name of await listDirs(root)) {
    const skill = await readSkillDir(join(root, name), name, layer, hooks);
    if (skill) out.push(skill);
  }
  return out;
}

async function scanPluginCacheRoot(root: string, hooks: ScanHooks): Promise<ScannedSkill[]> {
  // Layout: <root>/<marketplace>/<plugin>/<version>/skills/<name>/SKILL.md
  if (!(await exists(root))) return [];
  const out: ScannedSkill[] = [];
  // pluginKey → { version, skill } — lex-highest version wins per <plugin>:<name>
  const byKey: Map<string, { version: string; skill: ScannedSkill }> = new Map();
  const droppedVersions: string[] = [];

  for (const marketplace of await listDirs(root)) {
    const mpDir = join(root, marketplace);
    for (const plugin of await listDirs(mpDir)) {
      const plugDir = join(mpDir, plugin);
      const versions = (await listDirs(plugDir)).sort(); // lex sort, ascending
      for (const version of versions) {
        const skillsDir = join(plugDir, version, "skills");
        if (!(await exists(skillsDir))) continue;
        for (const skillName of await listDirs(skillsDir)) {
          const dottedName = `${plugin}:${skillName}`;
          const s = await readSkillDir(join(skillsDir, skillName), dottedName, "plugin-cache", hooks);
          if (!s) continue;
          const prev = byKey.get(dottedName);
          if (prev) {
            droppedVersions.push(
              `${prev.skill.sourcePath} (v${prev.version}) — superseded by v${version}`,
            );
          }
          byKey.set(dottedName, { version, skill: s });
        }
      }
    }
  }

  if (droppedVersions.length > 0) {
    hooks.log(
      `[claude-skills] plugin-cache version dedup dropped:\n  ${droppedVersions.join("\n  ")}`,
    );
  }
  for (const { skill } of byKey.values()) out.push(skill);
  return out;
}

export async function scanRoots(cfg: ScanRootsConfig, hooks: ScanHooks): Promise<ScannedSkill[]> {
  const project = cfg.projectRoot ? await scanFlatRoot(cfg.projectRoot, "project", hooks) : [];
  const user = cfg.userRoot ? await scanFlatRoot(cfg.userRoot, "user", hooks) : [];
  const cache = cfg.pluginCacheRoot ? await scanPluginCacheRoot(cfg.pluginCacheRoot, hooks) : [];
  // cache → user → project; "later wins" semantics in the caller's registry loop
  return [...cache, ...user, ...project];
}
