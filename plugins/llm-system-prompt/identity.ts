import { readFile } from "node:fs/promises";
import type { SystemPromptSection } from "./public";

export function buildFallback(fallbackPrefix: string, date: string): string {
  return `${fallbackPrefix} Today is ${date}. The user prefers concise answers and direct action; avoid unnecessary preamble. When tools are available, prefer calling them over guessing. When skills are listed below, load them on demand rather than guessing their contents.`;
}

export interface ResolveIdentityOptions {
  globalPath: string;
  projectPath: string;
  enabled?: boolean;
  projectHeader?: string;
  fallbackPrefix?: string;
}

export interface IdentityHandle {
  section: SystemPromptSection;
  reload(): Promise<void>;
}

const DEFAULT_PROJECT_HEADER = "## Project context";
const DEFAULT_FALLBACK_PREFIX =
  "You are a helpful assistant running locally via the kaizen local harness.";

async function readOrUndefined(path: string): Promise<string | undefined> {
  try {
    const t = await readFile(path, "utf8");
    return t.trim().length === 0 ? undefined : t.replace(/\s+$/, "");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

export function resolveIdentity(opts: ResolveIdentityOptions): IdentityHandle {
  const enabled = opts.enabled ?? true;
  const projectHeader = opts.projectHeader ?? DEFAULT_PROJECT_HEADER;
  const fallbackPrefix = opts.fallbackPrefix ?? DEFAULT_FALLBACK_PREFIX;
  let cachedGlobal: string | undefined;
  let cachedProject: string | undefined;

  async function reload(): Promise<void> {
    cachedGlobal = await readOrUndefined(opts.globalPath);
    cachedProject = await readOrUndefined(opts.projectPath);
  }

  function render(): string {
    if (!enabled) return "";

    const today = new Date().toISOString().slice(0, 10);

    if (cachedGlobal && cachedProject) {
      if (projectHeader === "") {
        return `${cachedGlobal}\n\n${cachedProject}`;
      }
      return `${cachedGlobal}\n\n${projectHeader}\n\n${cachedProject}`;
    }
    if (cachedGlobal) return cachedGlobal;
    if (cachedProject) return cachedProject;

    return buildFallback(fallbackPrefix, today);
  }

  const section: SystemPromptSection = {
    id: "identity",
    priority: 10,
    render,
  };

  return { section, reload };
}
