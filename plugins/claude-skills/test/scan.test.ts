import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { scanRoots, type ScannedSkill } from "../scan.ts";

const F = join(import.meta.dir, "fixtures");

function byName(skills: ScannedSkill[]): Record<string, ScannedSkill> {
  const out: Record<string, ScannedSkill> = {};
  for (const s of skills) out[s.name] = s;
  return out;
}

describe("scanRoots — three-roots fixture", () => {
  const projectRoot = join(F, "three-roots/project/.claude/skills");
  const userRoot = join(F, "three-roots/user/.claude/skills");
  const pluginCacheRoot = join(F, "three-roots/cache");

  it("discovers expected skills across all three layers with correct names", async () => {
    const errors: string[] = [];
    const logs: string[] = [];
    const result = await scanRoots({ projectRoot, userRoot, pluginCacheRoot }, {
      onError: (m) => errors.push(m),
      log: (m) => logs.push(m),
    });
    const idx = byName(result);
    expect(Object.keys(idx).sort()).toEqual(
      ["proj-only", "shared", "user-only", "plug-a:cached-a", "plug-b:cached-b"].sort(),
    );
  });

  it("derives 'shared' from the project layer, not user (project wins)", async () => {
    const result = await scanRoots({ projectRoot, userRoot, pluginCacheRoot }, { onError: () => {}, log: () => {} });
    const idx = byName(result);
    expect(idx["shared"]!.body).toBe("PROJECT WINS\n");
  });

  it("picks the lexicographically-highest version for a plugin-cache skill", async () => {
    const logs: string[] = [];
    const result = await scanRoots({ projectRoot, userRoot, pluginCacheRoot }, { onError: () => {}, log: (m) => logs.push(m) });
    const idx = byName(result);
    expect(idx["plug-a:cached-a"]!.body).toBe("NEW VERSION\n");
    expect(idx["plug-a:cached-a"]!.baseDir).toContain("plug-a/2.0.0/");
    expect(logs.join("\n")).toContain("1.0.0");
  });

  it("sets baseDir to the absolute directory containing SKILL.md", async () => {
    const result = await scanRoots({ projectRoot, userRoot, pluginCacheRoot }, { onError: () => {}, log: () => {} });
    const idx = byName(result);
    expect(idx["proj-only"]!.baseDir.endsWith("/project/.claude/skills/proj-only")).toBe(true);
    expect(idx["plug-b:cached-b"]!.baseDir.endsWith("/cache/mp1/plug-b/1.0.0/skills/cached-b")).toBe(true);
  });

  it("skips a <name>/ directory with no SKILL.md without erroring", async () => {
    const errors: string[] = [];
    const result = await scanRoots({ projectRoot, userRoot, pluginCacheRoot }, { onError: (m) => errors.push(m), log: () => {} });
    expect(result.find(s => s.name === "plug-c:orphan-no-skill")).toBeUndefined();
    expect(errors.join("\n")).not.toContain("orphan-no-skill");
  });

  it("returns layer information so the caller can order registrations", async () => {
    const result = await scanRoots({ projectRoot, userRoot, pluginCacheRoot }, { onError: () => {}, log: () => {} });
    const idx = byName(result);
    expect(idx["proj-only"]!.layer).toBe("project");
    expect(idx["user-only"]!.layer).toBe("user");
    expect(idx["plug-a:cached-a"]!.layer).toBe("plugin-cache");
  });
});

describe("scanRoots — bad frontmatter fixture", () => {
  const userRoot = join(F, "bad-frontmatter/user/.claude/skills");

  it("skips a skill with unclosed frontmatter and emits an error", async () => {
    const errors: string[] = [];
    const result = await scanRoots({ userRoot }, { onError: (m) => errors.push(m), log: () => {} });
    expect(result.find(s => s.name === "broken")).toBeUndefined();
    expect(errors.some(e => e.includes("broken"))).toBe(true);
  });

  it("skips a skill missing the description field and emits an error", async () => {
    const errors: string[] = [];
    const result = await scanRoots({ userRoot }, { onError: (m) => errors.push(m), log: () => {} });
    expect(result.find(s => s.name === "no-desc")).toBeUndefined();
    expect(errors.some(e => e.includes("no-desc"))).toBe(true);
  });

  it("never throws — bad skills are collected, scan returns", async () => {
    let threw = false;
    try {
      await scanRoots({ userRoot }, { onError: () => {}, log: () => {} });
    } catch { threw = true; }
    expect(threw).toBe(false);
  });
});

describe("scanRoots — non-existent roots", () => {
  it("returns empty results without erroring when roots don't exist", async () => {
    const errors: string[] = [];
    const result = await scanRoots(
      { projectRoot: "/does/not/exist/a", userRoot: "/does/not/exist/b", pluginCacheRoot: "/does/not/exist/c" },
      { onError: (m) => errors.push(m), log: () => {} },
    );
    expect(result).toEqual([]);
    expect(errors).toEqual([]);
  });
});
