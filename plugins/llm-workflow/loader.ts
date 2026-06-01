import type { WorkflowManifest } from "llm-contracts/public";
import { extractMeta } from "./meta-parse.ts";
import { MetaParseError } from "./errors.ts";

export interface LoaderDeps {
  readDir: (path: string) => Promise<string[]>;
  stat: (path: string) => Promise<{
    isFile: () => boolean;
    isDirectory: () => boolean;
    isSymbolicLink: () => boolean;
    size: number;
  }>;
  realpath: (path: string) => Promise<string>;
  readFile: (path: string) => Promise<string>;
}

export interface LoaderInput {
  userDir: string;
  projectDir: string;
  deps: LoaderDeps;
  maxFileBytes?: number;
}

export interface LoaderError { path: string; message: string; }

export interface LoaderResult {
  manifests: WorkflowManifest[];
  errors: LoaderError[];
}

const DEFAULT_MAX_BYTES = 64 * 1024;
const MAX_DEPTH = 8;

async function loadOneScope(
  rootDir: string,
  scope: "user" | "project",
  deps: LoaderDeps,
  maxBytes: number,
  errors: LoaderError[],
): Promise<WorkflowManifest[]> {
  const collected: string[] = [];
  const seenRealPaths = new Set<string>();

  async function walk(dir: string, depth: number): Promise<void> {
    let entries: string[];
    try { entries = await deps.readDir(dir); }
    catch (err: any) {
      if (err?.code === "ENOENT") return;
      errors.push({ path: dir, message: `failed to read dir: ${err?.message ?? err}` });
      return;
    }
    entries.sort();
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const fullPath = `${dir}/${entry}`;
      let st;
      try { st = await deps.stat(fullPath); }
      catch (err: any) { errors.push({ path: fullPath, message: `stat failed: ${err?.message ?? err}` }); continue; }
      if (st.isDirectory()) {
        if (depth >= MAX_DEPTH) { errors.push({ path: fullPath, message: `directory depth exceeds ${MAX_DEPTH}; skipped` }); continue; }
        let real = fullPath;
        if (st.isSymbolicLink()) {
          try { real = await deps.realpath(fullPath); }
          catch (err: any) { errors.push({ path: fullPath, message: `realpath failed: ${err?.message ?? err}` }); continue; }
          if (seenRealPaths.has(real)) { errors.push({ path: fullPath, message: `symlink cycle detected; skipped` }); continue; }
          seenRealPaths.add(real);
        } else {
          seenRealPaths.add(real);
        }
        await walk(fullPath, depth + 1);
        continue;
      }
      if (!st.isFile()) continue;
      if (!entry.endsWith(".ts")) continue;
      collected.push(fullPath);
    }
  }

  await walk(rootDir, 1);
  collected.sort();

  const out: WorkflowManifest[] = [];
  const seenNames = new Set<string>();
  for (const fullPath of collected) {
    let st;
    try { st = await deps.stat(fullPath); }
    catch (err: any) { errors.push({ path: fullPath, message: `stat failed: ${err?.message ?? err}` }); continue; }
    if (st.size > maxBytes) {
      errors.push({ path: fullPath, message: `workflow file exceeds ${maxBytes} byte cap (${st.size} bytes); skipped` });
      continue;
    }
    let text: string;
    try { text = await deps.readFile(fullPath); }
    catch (err: any) { errors.push({ path: fullPath, message: `read failed: ${err?.message ?? err}` }); continue; }
    let meta;
    try { meta = extractMeta(text); }
    catch (e) {
      const msg = e instanceof MetaParseError ? e.message : (e as Error).message;
      errors.push({ path: fullPath, message: msg });
      continue;
    }
    const basename = fullPath.substring(fullPath.lastIndexOf("/") + 1).replace(/\.ts$/, "");
    if (meta.name !== basename) {
      errors.push({ path: fullPath, message: `meta.name '${meta.name}' must match filename basename '${basename}'` });
      continue;
    }
    if (seenNames.has(meta.name)) {
      errors.push({ path: fullPath, message: `duplicate workflow name '${meta.name}' within ${scope} scope; lexicographic-first wins; this file skipped` });
      continue;
    }
    seenNames.add(meta.name);
    out.push({ meta, source: text, sourcePath: fullPath, scope });
  }
  return out;
}

export async function loadFromDirs(input: LoaderInput): Promise<LoaderResult> {
  const errors: LoaderError[] = [];
  const maxBytes = input.maxFileBytes ?? DEFAULT_MAX_BYTES;
  const userMs = await loadOneScope(input.userDir, "user", input.deps, maxBytes, errors);
  const projectMs = await loadOneScope(input.projectDir, "project", input.deps, maxBytes, errors);

  const byName = new Map<string, WorkflowManifest>();
  for (const m of userMs) byName.set(m.meta.name, m);
  for (const m of projectMs) {
    if (byName.has(m.meta.name)) {
      const existing = byName.get(m.meta.name)!;
      errors.push({
        path: m.sourcePath!,
        message: `project-scope workflow '${m.meta.name}' shadows user-scope at ${existing.sourcePath}`,
      });
    }
    byName.set(m.meta.name, m);
  }
  return { manifests: [...byName.values()], errors };
}
