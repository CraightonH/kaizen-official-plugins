import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureEnvironment } from "../environment.ts";
import { buildFixtures, type FixtureSet } from "./fixtures.ts";

let root: string;
let f: FixtureSet;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "llm-env-test-"));
  f = buildFixtures(root);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("captureEnvironment", () => {
  it("registers section with id, priority 30, and title", async () => {
    const handle = captureEnvironment({ cwd: f.nonGit });
    await handle.refresh();
    expect(handle.section.id).toBe("llm-environment:env");
    expect(handle.section.priority).toBe(30);
    expect(handle.section.title).toBe("Environment");
  });

  it("renders cwd and platform; omits git line when not a repo", async () => {
    const handle = captureEnvironment({ cwd: f.nonGit });
    await handle.refresh();
    const body = await handle.section.render();
    expect(body).toContain(`- Working directory: ${f.nonGit}`);
    expect(body).toContain(`- Platform: ${process.platform}`);
    expect(body).not.toContain("Git repo:");
  });

  it("renders branch when HEAD points to a ref", async () => {
    const handle = captureEnvironment({ cwd: f.gitBranch });
    await handle.refresh();
    expect(await handle.section.render()).toContain("- Git repo: main");
  });

  it("renders 'yes' when HEAD is detached", async () => {
    const handle = captureEnvironment({ cwd: f.gitDetached });
    await handle.refresh();
    const body = await handle.section.render();
    expect(body).toContain("- Git repo: yes");
    expect(body).not.toContain("- Git repo: main");
  });

  it("follows .git-as-file worktree pointer", async () => {
    const handle = captureEnvironment({ cwd: f.gitWorktree });
    await handle.refresh();
    expect(await handle.section.render()).toContain("- Git repo: feature");
  });

  it("treats malformed .git/HEAD as non-repo without throwing", async () => {
    const handle = captureEnvironment({ cwd: f.gitMalformed });
    await handle.refresh();
    expect(await handle.section.render()).not.toContain("Git repo:");
  });

  it("walks up to find .git in an ancestor directory", async () => {
    const handle = captureEnvironment({ cwd: join(f.gitBranch, "nonexistent-subdir", "..") });
    await handle.refresh();
    expect(await handle.section.render()).toContain("- Git repo: main");
  });

  it("returns empty string when KAIZEN_ENVIRONMENT_DISABLE=1", async () => {
    const handle = captureEnvironment({
      cwd: f.gitBranch,
      env: { KAIZEN_ENVIRONMENT_DISABLE: "1" },
    });
    await handle.refresh();
    expect(await handle.section.render()).toBe("");
  });

  it("refresh() picks up a branch change", async () => {
    const headPath = join(f.gitBranch, ".git", "HEAD");
    writeFileSync(headPath, "ref: refs/heads/main\n");
    const handle = captureEnvironment({ cwd: f.gitBranch });
    await handle.refresh();
    expect(await handle.section.render()).toContain("- Git repo: main");

    writeFileSync(headPath, "ref: refs/heads/feature-x\n");
    await handle.refresh();
    expect(await handle.section.render()).toContain("- Git repo: feature-x");
  });
});
