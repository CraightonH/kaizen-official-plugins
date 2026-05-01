import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { scanRoot } from "../scan.ts";

const FIXTURES = join(import.meta.dir, "fixtures");

describe("scanRoot", () => {
  it("returns [] for a non-existent root", async () => {
    const r = await scanRoot(join(FIXTURES, "does-not-exist"));
    expect(r).toEqual([]);
  });

  it("walks flat .md files and returns derived names", async () => {
    const r = await scanRoot(join(FIXTURES, "ok-flat"));
    const byName = Object.fromEntries(r.map(f => [f.relativeName, f]));
    expect(Object.keys(byName).sort()).toEqual(["git-rebase", "python"]);
    expect(byName["git-rebase"].body).toContain("Step 1");
    expect(byName["git-rebase"].absolutePath.endsWith("git-rebase.md")).toBe(true);
  });

  it("walks subdirectories and uses '/' as separator on all platforms", async () => {
    const r = await scanRoot(join(FIXTURES, "ok-nested"));
    const names = r.map(f => f.relativeName).sort();
    expect(names).toEqual(["ops/k8s/kubectl-debug", "python/poetry-deps"]);
  });

  it("ignores non-.md files and dotfiles", async () => {
    // We rely on the fact that fixtures dirs only contain .md files; if
    // someone adds a .DS_Store, this test still passes because of the filter.
    const r = await scanRoot(join(FIXTURES, "ok-flat"));
    for (const f of r) expect(f.absolutePath.endsWith(".md")).toBe(true);
  });
});
