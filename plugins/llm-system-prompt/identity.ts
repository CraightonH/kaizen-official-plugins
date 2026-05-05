import { readFile } from "node:fs/promises";
import type { SystemPromptSection } from "./public";

export const FALLBACK_PREFIX =
  "You are a helpful assistant running locally via the kaizen openai-compatible harness.";

const FALLBACK_TEMPLATE = (date: string): string =>
  `${FALLBACK_PREFIX} Today is ${date}. The user prefers concise answers and direct action; avoid unnecessary preamble. When tools are available, prefer calling them over guessing. When skills are listed below, load them on demand rather than guessing their contents.`;

const PROJECT_HEADER = "## Project context";

export interface ResolveIdentityOptions {
  globalPath: string;
  projectPath: string;
  env?: Record<string, string | undefined>;
}

export interface IdentityHandle {
  section: SystemPromptSection;
  reload(): Promise<void>;
}

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
  const env = opts.env ?? process.env;
  let cachedGlobal: string | undefined;
  let cachedProject: string | undefined;

  async function reload(): Promise<void> {
    cachedGlobal = await readOrUndefined(opts.globalPath);
    cachedProject = await readOrUndefined(opts.projectPath);
  }

  function render(): string {
    if (env.KAIZEN_SYSTEM_PROMPT_DISABLE === "1") return "";

    const today = new Date().toISOString().slice(0, 10);

    if (cachedGlobal && cachedProject) {
      return `${cachedGlobal}\n\n${PROJECT_HEADER}\n\n${cachedProject}`;
    }
    if (cachedGlobal) return cachedGlobal;
    if (cachedProject) return cachedProject;

    return FALLBACK_TEMPLATE(today);
  }

  const section: SystemPromptSection = {
    id: "identity",
    priority: 10,
    render,
  };

  return { section, reload };
}
