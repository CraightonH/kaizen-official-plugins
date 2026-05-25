// plugins/llm-local-tools/tools/grep.ts
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import type { ToolSchema } from "llm-contracts/public";
import { resolvePath } from "../util.ts";
import { DEFAULT_CONFIG } from "../config.ts";
import type { LlmLocalToolsConfig } from "../public.d.ts";

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
function probeRgOnce(): string | null {
  if (probedRg === undefined) probedRg = detectRgPath();
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

export interface GrepHandlerOpts {
  /** Override ripgrep probe — `null` forces JS fallback, omit/undefined to probe lazily. */
  rgPath?: string | null;
  /** Effective config. Defaults to DEFAULT_CONFIG. */
  config?: LlmLocalToolsConfig;
}

export function makeHandler(opts: GrepHandlerOpts = {}) {
  const config = opts.config ?? DEFAULT_CONFIG;
  return async function handler(args: GrepArgs, ctx: any): Promise<string> {
    const rg = opts.rgPath !== undefined ? opts.rgPath : probeRgOnce();
    if (rg) return runRipgrep(args, rg, ctx, config);
    return runJsFallback(args, config);
  };
}

function runRipgrep(args: GrepArgs, rgPath: string, ctx: any, config: LlmLocalToolsConfig): Promise<string> {
  const root = resolvePath(args.path ?? ".");
  const mode = args.output_mode ?? "content";
  const maxResults = Math.max(1, args.max_results ?? config.grepDefaultMax);
  const ctxLines = Math.max(0, args.context ?? 0);

  const argv: string[] = [
    "--no-config",
    "--color", "never",
    "--no-heading",
    "--with-filename",
    "--line-number",
  ];
  if (args.case_insensitive) argv.push("--ignore-case");
  if (args.glob) argv.push("--glob", args.glob);
  if (mode === "content") {
    if (ctxLines > 0) argv.push("--context", String(ctxLines));
    // ripgrep prints one line per match (with optional context); cap rough match output via -m per-file
    // and we'll also cap total in-process. Use --max-count for per-file safety.
    argv.push("--max-count", String(maxResults));
  } else if (mode === "files_with_matches") {
    argv.push("--files-with-matches");
  } else if (mode === "count") {
    argv.push("--count");
  }
  argv.push("--", args.pattern, root);

  return new Promise<string>((resolve) => {
    const child = spawn(rgPath, argv);
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let killed = false;
    const onAbort = () => {
      killed = true;
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
    };
    if (ctx?.signal) {
      if (ctx.signal.aborted) onAbort();
      else ctx.signal.addEventListener("abort", onAbort, { once: true });
    }
    child.stdout?.on("data", (b: Buffer) => { chunks.push(b); totalBytes += b.length; });
    child.stderr?.on("data", () => { /* swallow rg stderr; surface via exit handling */ });
    child.on("close", () => {
      if (ctx?.signal) ctx.signal.removeEventListener?.("abort", onAbort as any);
      if (killed) {
        resolve("");
        return;
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      // Apply a total-results cap on content mode (ripgrep's --max-count is per-file).
      if (mode === "content") {
        const lines = raw.split("\n");
        // Strip trailing empty line from final newline
        if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
        if (lines.length > maxResults) {
          const head = lines.slice(0, maxResults).join("\n");
          resolve(`${head}\n... [truncated: max_results=${maxResults} reached]`);
          return;
        }
        resolve(lines.join("\n"));
        return;
      }
      // files_with_matches / count: trim trailing newline only.
      resolve(raw.endsWith("\n") ? raw.slice(0, -1) : raw);
    });
    child.on("error", () => resolve(""));
  });
}

async function runJsFallback(args: GrepArgs, config: LlmLocalToolsConfig): Promise<string> {
  const root = resolvePath(args.path ?? ".");
  const flags = args.case_insensitive ? "i" : "";
  const re = new RegExp(args.pattern, flags);
  const mode = args.output_mode ?? "content";
  const maxResults = Math.max(1, args.max_results ?? config.grepDefaultMax);
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

// Default handler — probes rg lazily and uses DEFAULT_CONFIG.
export const handler = makeHandler();
