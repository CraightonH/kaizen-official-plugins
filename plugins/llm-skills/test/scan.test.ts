import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { scanRoot } from "../scan.ts";

const FIXTURES = join(import.meta.dir, "fixtures");

describe("scanRoot", () => {
  it("returns [] for a non-existent root", async () => {
    const r = await scanRoot(join(FIXTURES, "does-not-exist"));
    expect(r).toEqual([]);
  });

  it("discovers <name>/SKILL.md as a skill named <name>", async () => {
    const r = await scanRoot(join(FIXTURES, "ok-flat"));
    const byName = Object.fromEntries(r.map(f => [f.relativeName, f]));
    expect(Object.keys(byName).sort()).toEqual(["git-rebase", "python", "with-siblings"]);
    expect(byName["git-rebase"].body).toContain("Step 1");
    expect(byName["git-rebase"].absolutePath.endsWith("/git-rebase/SKILL.md")).toBe(true);
  });

  it("sets baseDir to the skill's directory (parent of SKILL.md)", async () => {
    const r = await scanRoot(join(FIXTURES, "ok-flat"));
    const git = r.find(f => f.relativeName === "git-rebase")!;
    expect(git.baseDir).toBe(join(FIXTURES, "ok-flat", "git-rebase"));
    expect(git.absolutePath).toBe(join(FIXTURES, "ok-flat", "git-rebase", "SKILL.md"));
  });

  it("ignores sibling files inside a skill directory", async () => {
    const r = await scanRoot(join(FIXTURES, "ok-flat"));
    // with-siblings/SKILL.md is found; with-siblings/notes.md must not appear.
    expect(r.some(f => f.absolutePath.endsWith("notes.md"))).toBe(false);
    expect(r.some(f => f.relativeName === "with-siblings")).toBe(true);
  });

  it("ignores nested layouts (e.g. <root>/group/name/SKILL.md)", async () => {
    // ok-nested has <root>/{ops,python}/... but no <root>/<X>/SKILL.md at depth 1.
    const r = await scanRoot(join(FIXTURES, "ok-nested"));
    expect(r).toEqual([]);
  });

  it("ignores dotfiles and directories starting with a dot", async () => {
    const r = await scanRoot(join(FIXTURES, "ok-flat"));
    for (const f of r) {
      expect(f.relativeName.startsWith(".")).toBe(false);
    }
  });

  it("returns stable alphabetic order regardless of readdir order", async () => {
    const r = await scanRoot(join(FIXTURES, "ok-flat"));
    const names = r.map(f => f.relativeName);
    expect([...names].sort()).toEqual(names);
  });
});
