import type { SkillManifest, SkillsRegistryService } from "llm-events/public";
import { parseFrontmatter } from "./frontmatter.ts";
import { scanRoot, type ScannedFile } from "./scan.ts";
import { estimateTokens } from "./tokens.ts";

export interface RegistryDeps {
  projectRoot?: string;     // <project>/.kaizen/skills
  userRoot?: string;        // ~/.kaizen/skills
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

interface Entry {
  manifest: SkillManifest;
  loader: () => Promise<string>;
  source: "project" | "user" | "programmatic";
}

export interface RescanResult { changed: boolean; count: number }

export interface SkillsRegistryServiceImpl extends SkillsRegistryService {
  rescan(): Promise<RescanResult>;
}

function loadFromScanned(
  files: ScannedFile[],
  source: "project" | "user",
  errorFn: (m: string) => void,
  warnFn: (m: string) => void,
): Map<string, Entry> {
  const out = new Map<string, Entry>();
  for (const f of files) {
    const parsed = parseFrontmatter(f.body);
    if (!parsed.ok) {
      errorFn(`[skills] skipped ${f.absolutePath}: ${parsed.error}`);
      continue;
    }
    if (parsed.manifest.name !== f.relativeName) {
      warnFn(`[skills] name mismatch in ${f.absolutePath}: frontmatter '${parsed.manifest.name}' vs path-derived '${f.relativeName}'; using path-derived`);
    }
    if (out.has(f.relativeName)) {
      errorFn(`[skills] duplicate name '${f.relativeName}' within ${source} layer (second occurrence at ${f.absolutePath} dropped)`);
      continue;
    }
    const tokens = parsed.manifest.tokens ?? estimateTokens(parsed.body);
    const manifest: SkillManifest = {
      name: f.relativeName,
      description: parsed.manifest.description,
      tokens,
    };
    const body = parsed.body;
    out.set(f.relativeName, {
      manifest,
      loader: async () => body,
      source,
    });
  }
  return out;
}

function snapshotKeys(merged: Map<string, Entry>): string {
  return [...merged.keys()].sort().join("\n");
}

export function makeRegistry(deps: RegistryDeps): SkillsRegistryServiceImpl {
  let project = new Map<string, Entry>();
  let user = new Map<string, Entry>();
  const programmatic = new Map<string, Entry>();
  let lastSnapshot = "";

  function merged(): Map<string, Entry> {
    const out = new Map<string, Entry>();
    // Lowest precedence first; later writes win.
    for (const [k, v] of programmatic) out.set(k, v);
    for (const [k, v] of user) {
      if (out.has(k)) deps.warn(`[skills] '${k}' from user layer masks programmatic registration`);
      out.set(k, v);
    }
    for (const [k, v] of project) {
      if (out.has(k)) deps.warn(`[skills] '${k}' from project layer masks lower-priority registration`);
      out.set(k, v);
    }
    return out;
  }

  return {
    list(): SkillManifest[] {
      const m = merged();
      return [...m.values()].map(e => e.manifest).sort((a, b) => a.name.localeCompare(b.name));
    },

    async load(name: string): Promise<string> {
      const m = merged();
      const e = m.get(name);
      if (!e) throw new Error(`unknown skill: ${name}`);
      return e.loader();
    },

    register(manifest, loader): () => void {
      programmatic.set(manifest.name, {
        manifest: { ...manifest, tokens: manifest.tokens ?? 0 },
        loader,
        source: "programmatic",
      });
      return () => { programmatic.delete(manifest.name); };
    },

    async rescan(): Promise<RescanResult> {
      const projFiles = deps.projectRoot ? await scanRoot(deps.projectRoot) : [];
      const userFiles = deps.userRoot ? await scanRoot(deps.userRoot) : [];
      project = loadFromScanned(projFiles, "project", deps.error, deps.warn);
      user = loadFromScanned(userFiles, "user", deps.error, deps.warn);
      const m = merged();
      const snap = snapshotKeys(m);
      const changed = snap !== lastSnapshot;
      lastSnapshot = snap;
      return { changed, count: m.size };
    },
  };
}
