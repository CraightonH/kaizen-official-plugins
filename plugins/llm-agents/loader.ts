import { parseAgentFile, type InternalAgentManifest } from "./frontmatter.ts";

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
}

export interface LoaderError { path: string; message: string; }

export interface LoaderResult {
  manifests: InternalAgentManifest[];
  errors: LoaderError[];
}

const MAX_BYTES = 64 * 1024;

async function loadOneScope(
  dir: string,
  scope: "user" | "project",
  deps: LoaderDeps,
  errors: LoaderError[],
): Promise<InternalAgentManifest[]> {
  let entries: string[];
  try { entries = await deps.readDir(dir); }
  catch (err: any) {
    if (err?.code === "ENOENT") return [];
    errors.push({ path: dir, message: `failed to read dir: ${err?.message ?? err}` });
    return [];
  }
  // Lexicographic order — Spec 11 collision rule (first lexicographic wins within scope).
  entries.sort();
  const out: InternalAgentManifest[] = [];
  const seenNames = new Set<string>();
  const seenRealPaths = new Set<string>();
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const fullPath = `${dir}/${entry}`;
    let st;
    try { st = await deps.stat(fullPath); }
    catch (err: any) { errors.push({ path: fullPath, message: `stat failed: ${err?.message ?? err}` }); continue; }
    if (!st.isFile()) continue;
    if (st.size > MAX_BYTES) {
      errors.push({ path: fullPath, message: `agent file exceeds 64 KiB cap (${st.size} bytes); skipped` });
      continue;
    }
    let real = fullPath;
    if (st.isSymbolicLink()) {
      try { real = await deps.realpath(fullPath); }
      catch (err: any) { errors.push({ path: fullPath, message: `realpath failed: ${err?.message ?? err}` }); continue; }
      if (real === fullPath || seenRealPaths.has(real)) {
        errors.push({ path: fullPath, message: `symlink cycle detected; skipped` });
        continue;
      }
    }
    seenRealPaths.add(real);
    let text: string;
    try { text = await deps.readFile(fullPath); }
    catch (err: any) { errors.push({ path: fullPath, message: `read failed: ${err?.message ?? err}` }); continue; }
    const parsed = parseAgentFile(text, fullPath);
    if (!parsed.ok) { errors.push({ path: fullPath, message: parsed.error }); continue; }
    if (seenNames.has(parsed.manifest.name)) {
      errors.push({ path: fullPath, message: `duplicate agent name '${parsed.manifest.name}' within ${scope} scope; lexicographic-first wins; this file skipped` });
      continue;
    }
    seenNames.add(parsed.manifest.name);
    out.push({ ...parsed.manifest, sourcePath: fullPath, scope });
  }
  return out;
}

export async function loadFromDirs(input: LoaderInput): Promise<LoaderResult> {
  const errors: LoaderError[] = [];
  const userMs = await loadOneScope(input.userDir, "user", input.deps, errors);
  const projectMs = await loadOneScope(input.projectDir, "project", input.deps, errors);

  // Project shadows user.
  const byName = new Map<string, InternalAgentManifest>();
  for (const m of userMs) byName.set(m.name, m);
  for (const m of projectMs) {
    if (byName.has(m.name)) {
      const existing = byName.get(m.name)!;
      errors.push({
        path: m.sourcePath,
        message: `project-scope agent '${m.name}' shadows user-scope agent at ${existing.sourcePath}`,
      });
    }
    byName.set(m.name, m);
  }
  return { manifests: [...byName.values()], errors };
}
