import { existsSync, readFileSync, statSync } from "node:fs";
import { release } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { EnvironmentSnapshot, GitSnapshot } from "./public";

export interface CaptureOptions {
  cwd: string;
  env?: Record<string, string | undefined>;
}

export interface SectionLike {
  id: string;
  priority: number;
  title: string;
  render(): Promise<string>;
}

export interface EnvironmentHandle {
  section: SectionLike;
  refresh(): Promise<void>;
}

const SECTION_ID = "llm-environment:env";
const SECTION_PRIORITY = 30;
const SECTION_TITLE = "Environment";

function detectGit(startCwd: string): GitSnapshot {
  try {
    let dir = resolve(startCwd);
    while (true) {
      const candidate = join(dir, ".git");
      if (existsSync(candidate)) {
        return readGitAt(candidate);
      }
      const parent = dirname(dir);
      if (parent === dir) return { isRepo: false };
      dir = parent;
    }
  } catch {
    return { isRepo: false };
  }
}

function readGitAt(gitPath: string): GitSnapshot {
  try {
    const st = statSync(gitPath);
    let realGitDir = gitPath;
    if (st.isFile()) {
      const pointer = readFileSync(gitPath, "utf8").trim();
      const match = pointer.match(/^gitdir:\s*(.+)$/);
      if (!match) return { isRepo: false };
      const target = match[1]!.trim();
      realGitDir = isAbsolute(target) ? target : resolve(dirname(gitPath), target);
    } else if (!st.isDirectory()) {
      return { isRepo: false };
    }
    const headPath = join(realGitDir, "HEAD");
    if (!existsSync(headPath)) return { isRepo: true };
    const head = readFileSync(headPath, "utf8").trim();
    const refMatch = head.match(/^ref:\s*refs\/heads\/(.+)$/);
    if (refMatch) return { isRepo: true, branch: refMatch[1]!.trim() };
    if (/^[0-9a-f]{4,}$/i.test(head)) return { isRepo: true };
    return { isRepo: false };
  } catch {
    return { isRepo: false };
  }
}

export function captureEnvironment(opts: CaptureOptions): EnvironmentHandle {
  const env = opts.env ?? process.env;
  let snapshot: EnvironmentSnapshot = {
    cwd: opts.cwd,
    platform: `${process.platform} (${release()})`,
    git: { isRepo: false },
  };

  async function refresh(): Promise<void> {
    snapshot = {
      cwd: opts.cwd,
      platform: `${process.platform} (${release()})`,
      git: detectGit(opts.cwd),
    };
  }

  function render(): string {
    if (env.KAIZEN_ENVIRONMENT_DISABLE === "1") return "";
    const lines: string[] = [
      `- Working directory: ${snapshot.cwd}`,
      `- Platform: ${snapshot.platform}`,
    ];
    if (snapshot.git.isRepo) {
      lines.push(`- Git branch: ${snapshot.git.branch ?? "(detached HEAD)"}`);
    }
    return lines.join("\n");
  }

  return {
    section: {
      id: SECTION_ID,
      priority: SECTION_PRIORITY,
      title: SECTION_TITLE,
      render: async () => render(),
    },
    refresh,
  };
}
