import { readFile, writeFile, rename, unlink, mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { listMemoryFiles } from "./paths.ts";
import { parseEntry, renderEntry, validateName } from "./frontmatter.ts";
import type { MemoryEntry, MemoryScope, MemoryStoreService, MemoryType } from "./public.d.ts";

export interface StoreDeps {
  globalDir: string;
  projectDir: string | null;
  /** Re-render MEMORY.md for the given directory. Wired by service.ts to catalog.regenerate. */
  regenerateIndex: (dir: string) => Promise<void>;
  log: (msg: string) => void;
  /** Override-able clock for tests. Returns ISO-8601 string. */
  now?: () => string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function dirFor(deps: StoreDeps, scope: MemoryScope): string | null {
  return scope === "global" ? deps.globalDir : deps.projectDir;
}

async function readEntryFile(dir: string, file: string, scope: MemoryScope): Promise<MemoryEntry | null> {
  let text: string;
  try {
    text = await readFile(join(dir, file), "utf8");
  } catch (err: any) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
  return parseEntry(text, scope);
}

async function readDirEntries(dir: string | null, scope: MemoryScope): Promise<MemoryEntry[]> {
  if (!dir) return [];
  const files = await listMemoryFiles(dir);
  const out: MemoryEntry[] = [];
  for (const f of files) {
    const e = await readEntryFile(dir, f, scope);
    if (e) out.push(e);
  }
  return out;
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

export function makeStore(deps: StoreDeps): MemoryStoreService {
  const clock = deps.now ?? nowIso;

  async function get(name: string, opts?: { scope?: MemoryScope }): Promise<MemoryEntry | null> {
    if (!validateName(name)) return null;
    const scopes: MemoryScope[] = opts?.scope ? [opts.scope] : ["project", "global"];
    for (const sc of scopes) {
      const dir = dirFor(deps, sc);
      if (!dir) continue;
      const e = await readEntryFile(dir, `${name}.md`, sc);
      if (e) return e;
    }
    return null;
  }

  async function list(filter?: { type?: MemoryType; scope?: MemoryScope }): Promise<MemoryEntry[]> {
    const scopes: MemoryScope[] = filter?.scope ? [filter.scope] : ["project", "global"];
    const out: MemoryEntry[] = [];
    for (const sc of scopes) {
      out.push(...(await readDirEntries(dirFor(deps, sc), sc)));
    }
    return filter?.type ? out.filter((e) => e.type === filter.type) : out;
  }

  async function search(query: string, opts?: { scope?: MemoryScope; limit?: number }): Promise<MemoryEntry[]> {
    const q = query.toLowerCase();
    const all = await list({ scope: opts?.scope });
    const matches = all.filter(
      (e) => e.name.toLowerCase().startsWith(q) || e.description.toLowerCase().includes(q),
    );
    return matches.slice(0, opts?.limit ?? 5);
  }

  async function put(entry: MemoryEntry): Promise<void> {
    if (!validateName(entry.name)) throw new Error(`memory:store.put: invalid name "${entry.name}"`);
    const dir = dirFor(deps, entry.scope);
    if (!dir) throw new Error(`memory:store.put: scope "${entry.scope}" disabled (projectDir=null)`);
    const existing = await readEntryFile(dir, `${entry.name}.md`, entry.scope);
    const created = existing?.created ?? clock();
    const updated = clock();
    const finalEntry: MemoryEntry = { ...entry, created, updated };
    const text = renderEntry(finalEntry);
    await atomicWrite(dir, `${entry.name}.md`, text);
    await deps.regenerateIndex(dir);
  }

  async function remove(name: string, scope: MemoryScope): Promise<void> {
    if (!validateName(name)) return;
    const dir = dirFor(deps, scope);
    if (!dir) return;
    try {
      await unlink(join(dir, `${name}.md`));
    } catch (err: any) {
      if (err?.code !== "ENOENT") throw err;
      return;
    }
    await deps.regenerateIndex(dir);
  }

  async function readIndex(scope: MemoryScope): Promise<string> {
    const dir = dirFor(deps, scope);
    if (!dir) return "";
    try {
      return await readFile(join(dir, "MEMORY.md"), "utf8");
    } catch (err: any) {
      if (err?.code === "ENOENT") return "";
      throw err;
    }
  }

  return { get, list, search, put, remove, readIndex };
}
