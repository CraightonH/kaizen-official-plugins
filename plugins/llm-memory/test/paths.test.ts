import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDirs, ensureDir, listMemoryFiles, sweepStaleTempFiles } from "../paths.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "llm-memory-paths-"));
}

describe("resolveDirs", () => {
  it("uses defaults: <home>/.kaizen/memory and <cwd>/.kaizen/memory", () => {
    const out = resolveDirs({ home: "/home/u", cwd: "/work/p", config: {} });
    expect(out.globalDir).toBe("/home/u/.kaizen/memory");
    expect(out.projectDir).toBe("/work/p/.kaizen/memory");
  });
  it("honors absolute overrides verbatim", () => {
    const out = resolveDirs({ home: "/h", cwd: "/c", config: { globalDir: "/etc/g", projectDir: "/etc/p" } });
    expect(out.globalDir).toBe("/etc/g");
    expect(out.projectDir).toBe("/etc/p");
  });
  it("expands leading ~ in overrides", () => {
    const out = resolveDirs({ home: "/h", cwd: "/c", config: { globalDir: "~/x", projectDir: "~/y" } });
    expect(out.globalDir).toBe("/h/x");
    expect(out.projectDir).toBe("/h/y");
  });
  it("projectDir=null disables project layer", () => {
    const out = resolveDirs({ home: "/h", cwd: "/c", config: { projectDir: null } });
    expect(out.projectDir).toBeNull();
  });
});

describe("ensureDir", () => {
  it("creates a missing directory recursively", async () => {
    const root = tmp();
    const target = join(root, "a", "b", "c");
    await ensureDir(target);
    expect(existsSync(target)).toBe(true);
  });
  it("is a no-op for an existing directory", async () => {
    const root = tmp();
    await ensureDir(root);
    await ensureDir(root); // must not throw
    expect(existsSync(root)).toBe(true);
  });
});

describe("listMemoryFiles", () => {
  it("returns *.md files (excluding MEMORY.md and dotfiles)", async () => {
    const root = tmp();
    writeFileSync(join(root, "a.md"), "x");
    writeFileSync(join(root, "b.md"), "x");
    writeFileSync(join(root, "MEMORY.md"), "x");
    writeFileSync(join(root, ".hidden.md"), "x");
    writeFileSync(join(root, "notes.txt"), "x");
    const files = await listMemoryFiles(root);
    expect(files.sort()).toEqual(["a.md", "b.md"]);
  });
  it("returns [] for a missing directory", async () => {
    expect(await listMemoryFiles(join(tmp(), "nope"))).toEqual([]);
  });
});

describe("sweepStaleTempFiles", () => {
  it("removes .tmp.* older than threshold; preserves fresh ones", async () => {
    const root = tmp();
    const stalePath = join(root, "x.md.tmp.1.abcd");
    const freshPath = join(root, "x.md.tmp.2.efgh");
    writeFileSync(stalePath, "stale");
    writeFileSync(freshPath, "fresh");
    // Backdate stalePath
    const past = Date.now() - 5 * 60 * 1000;
    const fs = await import("node:fs/promises");
    await fs.utimes(stalePath, past / 1000, past / 1000);
    const removed = await sweepStaleTempFiles(root, 60_000);
    expect(removed).toContain(stalePath);
    expect(existsSync(stalePath)).toBe(false);
    expect(existsSync(freshPath)).toBe(true);
  });
});
