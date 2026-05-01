// plugins/llm-local-tools/util.ts
import { stat as fsStat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";

export const MAX_READ_BYTES = 50 * 1024 * 1024;
export const READ_CAP_BYTES = 256 * 1024;
export const READ_CAP_LINES = 2000;
export const BASH_OUTPUT_CAP = 256 * 1024;
export const GREP_DEFAULT_MAX = 200;
export const GLOB_CAP = 1000;

export function resolvePath(p: string, baseCwd?: string): string {
  if (isAbsolute(p)) return p;
  return resolve(baseCwd ?? process.cwd(), p);
}

export function truncateBytes(s: string, max: number, marker: string): string {
  if (Buffer.byteLength(s, "utf8") <= max) return s;
  const buf = Buffer.from(s, "utf8");
  return buf.subarray(0, max).toString("utf8") + "\n" + marker;
}

export function truncateMiddle(s: string, max: number, marker: string): string {
  const len = Buffer.byteLength(s, "utf8");
  if (len <= max) return s;
  const half = Math.floor((max - marker.length - 2) / 2);
  if (half <= 0) return marker;
  const buf = Buffer.from(s, "utf8");
  const head = buf.subarray(0, half).toString("utf8");
  const tail = buf.subarray(buf.length - half).toString("utf8");
  return `${head}\n${marker}\n${tail}`;
}

export function sniffBinary(buf: Buffer): boolean {
  const slice = buf.subarray(0, Math.min(buf.length, 8 * 1024));
  for (let i = 0; i < slice.length; i++) if (slice[i] === 0) return true;
  return false;
}

export async function ensureParentExists(absPath: string): Promise<void> {
  const parent = dirname(absPath);
  let st;
  try {
    st = await fsStat(parent);
  } catch (err: any) {
    throw new Error(`parent directory does not exist: ${parent}`);
  }
  if (!st.isDirectory()) throw new Error(`parent directory is not a directory: ${parent}`);
}

export function hasGitRoot(cwd: string): boolean {
  let cur = resolve(cwd);
  for (;;) {
    if (existsSync(`${cur}${sep}.git`)) return true;
    const parent = dirname(cur);
    if (parent === cur) return false;
    cur = parent;
  }
}

export function formatLineNumbered(text: string, startLine: number): string {
  const lines = text.split("\n");
  return lines.map((line, i) => {
    const n = String(startLine + i).padStart(6, " ");
    return `${n}\t${line}`;
  }).join("\n");
}
