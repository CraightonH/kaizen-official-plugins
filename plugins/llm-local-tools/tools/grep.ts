// plugins/llm-local-tools/tools/grep.ts
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { spawnSync } from "node:child_process";
import type { ToolSchema } from "llm-events/public";
import { resolvePath, GREP_DEFAULT_MAX } from "../util.ts";

export const schema: ToolSchema = {
  name: "grep",
  description: "Search file contents for a regex. Wraps ripgrep when available. Returns matching lines with file:line:content.",
  parameters: {
    type: "object",
    properties: {
      pattern:           { type: "string", description: "Regex pattern (Rust regex syntax when ripgrep is used; ECMAScript otherwise)." },
      path:              { type: "string", description: "File or directory to search. Defaults to process cwd." },
      glob:              { type: "string", description: "Restrict to files matching this glob (e.g. `*.ts`)." },
      case_insensitive:  { type: "boolean", default: false },
      output_mode:       { type: "string", enum: ["content", "files_with_matches", "count"], default: "content" },
      context:           { type: "integer", minimum: 0, description: "Lines of before/after context (content mode only)." },
      max_results:       { type: "integer", minimum: 1, description: "Cap on returned matches/files. Default 200." },
    },
    required: ["pattern"],
  },
  tags: ["local", "fs"],
};

interface GrepArgs {
  pattern: string;
  path?: string;
  glob?: string;
  case_insensitive?: boolean;
  output_mode?: "content" | "files_with_matches" | "count";
  context?: number;
  max_results?: number;
}

function detectRgPath(): string | null {
  try {
    const r = spawnSync("which", ["rg"], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  } catch { /* ignore */ }
  return null;
}

let probedRg: string | null | undefined = undefined;
let warned = false;
function probeRgOnce(log: (msg: string) => void): string | null {
  if (probedRg === undefined) {
    probedRg = detectRgPath();
    if (probedRg === null && !warned) {
      log("grep: ripgrep not found; using JS fallback (slower)");
      warned = true;
    }
  }
  return probedRg;
}

function compileGlob(pattern: string): RegExp {
  let re = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") { re += ".*"; i++; if (pattern[i + 1] === "/") i++; }
      else re += "[^/]*";
    } else if (ch === "?") re += "[^/]";
    else if (".+^$()[]{}|\\".includes(ch)) re += "\\" + ch;
    else re += ch;
  }
  return new RegExp(re + "$");
}

async function walkFiles(root: string, out: string[]): Promise<void> {
  let st;
  try { st = await stat(root); } catch { return; }
  if (st.isFile()) { out.push(root); return; }
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name === ".git" || e.name === "node_modules") continue;
    const abs = join(root, e.name);
    if (e.isDirectory()) await walkFiles(abs, out);
    else if (e.isFile()) out.push(abs);
  }
}

export function makeHandler(opts: { rgPath: string | null }) {
  return async function handler(args: GrepArgs, ctx: any): Promise<string> {
    const log = (ctx?.log ?? (() => {})) as (m: string) => void;
    const rg = opts.rgPath !== undefined ? opts.rgPath : probeRgOnce(log);
    return runJsFallback(args, rg);
  };
}

async function runJsFallback(args: GrepArgs, _rg: string | null): Promise<string> {
  const root = resolvePath(args.path ?? ".");
  const flags = args.case_insensitive ? "i" : "";
  const re = new RegExp(args.pattern, flags);
  const mode = args.output_mode ?? "content";
  const maxResults = Math.max(1, args.max_results ?? GREP_DEFAULT_MAX);
  const ctxLines = Math.max(0, args.context ?? 0);
  const globRe = args.glob ? compileGlob(args.glob) : null;

  const files: string[] = [];
  await walkFiles(root, files);
  const filtered = globRe ? files.filter(f => globRe.test(relative(root, f).split(sep).join("/"))) : files;

  if (mode === "files_with_matches") {
    const hits: string[] = [];
    for (const f of filtered) {
      try {
        const text = await readFile(f, "utf8");
        if (re.test(text)) hits.push(f);
        if (hits.length >= maxResults) break;
      } catch { /* skip */ }
    }
    return hits.join("\n");
  }

  if (mode === "count") {
    const lines: string[] = [];
    for (const f of filtered) {
      try {
        const text = await readFile(f, "utf8");
        let n = 0;
        for (const ln of text.split("\n")) if (re.test(ln)) n++;
        if (n > 0) lines.push(`${f}:${n}`);
        if (lines.length >= maxResults) break;
      } catch { /* skip */ }
    }
    return lines.join("\n");
  }

  // content mode
  const out: string[] = [];
  let total = 0;
  for (const f of filtered) {
    let text: string;
    try { text = await readFile(f, "utf8"); } catch { continue; }
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        const start = Math.max(0, i - ctxLines);
        const end = Math.min(lines.length - 1, i + ctxLines);
        for (let k = start; k <= end; k++) {
          out.push(`${f}:${k + 1}:${lines[k]}`);
          total++;
          if (total >= maxResults) {
            out.push(`... [truncated: max_results=${maxResults} reached]`);
            return out.join("\n");
          }
        }
      }
    }
  }
  return out.join("\n");
}

// Default handler — probes rg lazily.
export const handler = makeHandler({ rgPath: undefined as any });
