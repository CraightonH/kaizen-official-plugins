// plugins/llm-local-tools/tools/glob.ts
import { readdir, stat, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { ToolSchema } from "llm-events/public";
import { resolvePath, hasGitRoot, GLOB_CAP } from "../util.ts";

export const schema: ToolSchema = {
  name: "glob",
  description: "Find files by glob pattern. Returns absolute paths sorted by mtime descending (most recently modified first).",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern, e.g. `**/*.ts` or `src/**/test_*.py`." },
      cwd:     { type: "string", description: "Directory to glob from. Defaults to process cwd." },
    },
    required: ["pattern"],
  },
  tags: ["local", "fs"],
};

interface GlobArgs { pattern: string; cwd?: string; }

interface IgnoreSet { patterns: RegExp[]; }

function compileGitignore(text: string): IgnoreSet {
  const patterns: RegExp[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    // Translate simple gitignore globs (*, ?, **) to regex, anchored loosely.
    let re = "";
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === "*") {
        if (line[i + 1] === "*") { re += ".*"; i++; } else { re += "[^/]*"; }
      } else if (ch === "?") re += "[^/]";
      else if (".+^$()[]{}|\\".includes(ch)) re += "\\" + ch;
      else re += ch;
    }
    patterns.push(new RegExp(`(^|/)${re}($|/)`));
  }
  return { patterns };
}

function isIgnored(rel: string, ig: IgnoreSet): boolean {
  for (const p of ig.patterns) if (p.test(rel)) return true;
  return false;
}

function compileGlob(pattern: string): RegExp {
  let re = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i++;
        if (pattern[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") re += "[^/]";
    else if (".+^$()[]{}|\\".includes(ch)) re += "\\" + ch;
    else re += ch;
  }
  re += "$";
  return new RegExp(re);
}

async function walk(root: string, cwd: string, ig: IgnoreSet | null, out: { abs: string; mtime: number }[]): Promise<void> {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name === ".git") continue;
    const abs = join(root, e.name);
    if (e.isDirectory()) {
      if (ig) {
        const rel = relative(cwd, abs);
        if (isIgnored(rel, ig)) continue;
      }
      await walk(abs, cwd, ig, out);
    } else if (e.isFile()) {
      if (ig) {
        const rel = relative(cwd, abs);
        if (isIgnored(rel, ig)) continue;
      }
      try {
        const st = await stat(abs);
        out.push({ abs, mtime: st.mtimeMs });
      } catch { /* ignore */ }
    }
  }
}

export async function handler(args: GlobArgs, _ctx: unknown): Promise<string> {
  const cwd = resolvePath(args.cwd ?? ".");
  const useGitignore = hasGitRoot(cwd);
  let ig: IgnoreSet | null = null;
  if (useGitignore) {
    try {
      const text = await readFile(join(cwd, ".gitignore"), "utf8");
      ig = compileGitignore(text);
    } catch { ig = { patterns: [] }; }
  }
  const collected: { abs: string; mtime: number }[] = [];
  await walk(cwd, cwd, ig, collected);
  const re = compileGlob(args.pattern);
  const matches = collected.filter(f => re.test(relative(cwd, f.abs).split(sep).join("/")));
  matches.sort((a, b) => b.mtime - a.mtime);
  const total = matches.length;
  const shown = matches.slice(0, GLOB_CAP).map(m => m.abs);
  const lines = shown.join("\n");
  if (total > GLOB_CAP) return `${lines}\n... [truncated: ${total - GLOB_CAP} more matches]`;
  return lines;
}
