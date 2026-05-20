import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface FixtureSet {
  gitBranch: string;
  gitDetached: string;
  gitWorktree: string;
  gitMalformed: string;
  nonGit: string;
}

/**
 * Build the git-detection fixture tree under `root`. Returns the absolute
 * paths of each fixture's working-directory root (the dir that callers will
 * pass as `cwd` to captureEnvironment).
 *
 * These cannot be checked in as static files because git refuses to track
 * any path under a `.git/` directory. They are built per-test instead.
 */
export function buildFixtures(root: string): FixtureSet {
  const gitBranch = join(root, "git-branch");
  const gitDetached = join(root, "git-detached");
  const gitWorktree = join(root, "git-worktree");
  const gitMalformed = join(root, "git-malformed");
  const nonGit = join(root, "non-git");

  // git-branch: HEAD points to refs/heads/main
  mkdirSync(join(gitBranch, ".git", "refs", "heads"), { recursive: true });
  writeFileSync(join(gitBranch, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(gitBranch, ".git", "refs", "heads", "main"), "");

  // git-detached: HEAD contains a hex SHA (no ref: prefix)
  mkdirSync(join(gitDetached, ".git"), { recursive: true });
  writeFileSync(
    join(gitDetached, ".git", "HEAD"),
    "1234567890abcdef1234567890abcdef12345678\n",
  );

  // git-worktree: .git is a FILE containing "gitdir: .realgit", which points
  // to a sibling .realgit/ directory with HEAD on refs/heads/feature
  mkdirSync(join(gitWorktree, ".realgit", "refs", "heads"), { recursive: true });
  writeFileSync(join(gitWorktree, ".git"), "gitdir: .realgit\n");
  writeFileSync(join(gitWorktree, ".realgit", "HEAD"), "ref: refs/heads/feature\n");
  writeFileSync(join(gitWorktree, ".realgit", "refs", "heads", "feature"), "");

  // git-malformed: HEAD contains a single space + newline
  mkdirSync(join(gitMalformed, ".git"), { recursive: true });
  writeFileSync(join(gitMalformed, ".git", "HEAD"), " \n");

  // non-git: empty directory
  mkdirSync(nonGit, { recursive: true });

  return { gitBranch, gitDetached, gitWorktree, gitMalformed, nonGit };
}
