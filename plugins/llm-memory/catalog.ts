import { readFile, writeFile, rename, unlink, mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { listMemoryFiles } from "./paths.ts";
import { parseEntry } from "./frontmatter.ts";
import type { MemoryEntry } from "./public.d.ts";

export const CATALOG_START = "<!-- llm-memory:catalog:start -->";
export const CATALOG_END = "<!-- llm-memory:catalog:end -->";

export function renderCatalog(entries: MemoryEntry[]): string {
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  const bullets = sorted.map((e) => `- [${e.name}](${e.name}.md) — ${e.description}`);
  if (bullets.length === 0) return `${CATALOG_START}\n${CATALOG_END}`;
  return `${CATALOG_START}\n${bullets.join("\n")}\n${CATALOG_END}`;
}

export function mergeIntoIndex(prev: string, catalog: string): string {
  const start = prev.indexOf(CATALOG_START);
  const end = prev.indexOf(CATALOG_END);
  if (start === -1 || end === -1 || end < start) {
    // No markers — append catalog block at the end with a newline separator.
    const sep = prev.length === 0 || prev.endsWith("\n") ? "" : "\n";
    return `${prev}${sep}${catalog}\n`;
  }
  const before = prev.slice(0, start);
  const afterEnd = prev.slice(end + CATALOG_END.length);
  // Drop a leading newline in afterEnd to avoid double blank lines.
  const tail = afterEnd.startsWith("\n") ? afterEnd : `\n${afterEnd}`;
  return `${before}${catalog}${tail}`;
}

async function atomicWrite(dir: string, name: string, body: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const tempName = `${name}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`;
  const tempPath = join(dir, tempName);
  const finalPath = join(dir, name);
  await writeFile(tempPath, body, { encoding: "utf8", flag: "wx" });
  try {
    await rename(tempPath, finalPath);
  } catch (err) {
    try { await unlink(tempPath); } catch {}
    throw err;
  }
}

export async function regenerateIndex(dir: string): Promise<void> {
  const files = await listMemoryFiles(dir);
  const entries: MemoryEntry[] = [];
  for (const f of files) {
    let text: string;
    try {
      text = await readFile(join(dir, f), "utf8");
    } catch {
      continue;
    }
    const e = parseEntry(text, "global"); // scope is irrelevant for catalog rendering.
    if (e) entries.push(e);
  }
  let prev = "";
  try {
    prev = await readFile(join(dir, "MEMORY.md"), "utf8");
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw err;
  }
  const out = mergeIntoIndex(prev, renderCatalog(entries));
  await atomicWrite(dir, "MEMORY.md", out);
}
