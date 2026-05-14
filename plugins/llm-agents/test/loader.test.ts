import { describe, it, expect, mock } from "bun:test";
import { loadFromDirs, type LoaderDeps } from "../loader.ts";

interface FakeFile { kind: "file"; content: string; isSymlink?: boolean; realPath?: string; size?: number; }
interface FakeDir { kind: "dir"; entries: string[]; }
type Node = FakeFile | FakeDir;

function makeDeps(tree: Record<string, Node>): LoaderDeps {
  return {
    readDir: async (p) => {
      const n = tree[p];
      if (!n) { const e: any = new Error("ENOENT"); e.code = "ENOENT"; throw e; }
      if (n.kind !== "dir") throw new Error(`not a dir: ${p}`);
      return n.entries;
    },
    stat: async (p) => {
      const n = tree[p];
      if (!n) { const e: any = new Error("ENOENT"); e.code = "ENOENT"; throw e; }
      return {
        isFile: () => n.kind === "file",
        isDirectory: () => n.kind === "dir",
        isSymbolicLink: () => n.kind === "file" && !!n.isSymlink,
        size: n.kind === "file" ? (n.size ?? n.content.length) : 0,
      } as any;
    },
    realpath: async (p) => {
      const n = tree[p];
      if (n?.kind === "file" && n.isSymlink) return n.realPath ?? p;
      return p;
    },
    readFile: async (p) => {
      const n = tree[p];
      if (!n || n.kind !== "file") { const e: any = new Error("ENOENT"); e.code = "ENOENT"; throw e; }
      return n.content;
    },
  };
}

const VALID = `---\nname: a\ndescription: "d"\n---\nbody\n`;

describe("loadFromDirs", () => {
  it("user-only when project dir absent", async () => {
    const deps = makeDeps({
      "/u/agents": { kind: "dir", entries: ["a.md"] },
      "/u/agents/a.md": { kind: "file", content: VALID },
    });
    const r = await loadFromDirs({ userDir: "/u/agents", projectDir: "/p/agents", deps });
    expect(r.manifests.length).toBe(1);
    expect(r.manifests[0]!.scope).toBe("user");
    expect(r.errors).toEqual([]);
  });

  it("project-scope shadows user-scope on name collision and emits a shadowing error", async () => {
    const PROJECT = `---\nname: a\ndescription: "project version"\n---\nbody2\n`;
    const deps = makeDeps({
      "/u/agents": { kind: "dir", entries: ["a.md"] },
      "/u/agents/a.md": { kind: "file", content: VALID },
      "/p/agents": { kind: "dir", entries: ["a.md"] },
      "/p/agents/a.md": { kind: "file", content: PROJECT },
    });
    const r = await loadFromDirs({ userDir: "/u/agents", projectDir: "/p/agents", deps });
    expect(r.manifests.length).toBe(1);
    expect(r.manifests[0]!.scope).toBe("project");
    expect(r.manifests[0]!.description).toBe("project version");
    expect(r.errors.some((e) => /shadow/i.test(e.message))).toBe(true);
  });

  it("rejects oversize files", async () => {
    const big = "---\nname: big\ndescription: d\n---\n" + "x".repeat(64 * 1024 + 1);
    const deps = makeDeps({
      "/u/agents": { kind: "dir", entries: ["big.md"] },
      "/u/agents/big.md": { kind: "file", content: big, size: big.length },
    });
    const r = await loadFromDirs({ userDir: "/u/agents", projectDir: "/p/agents", deps });
    expect(r.manifests).toEqual([]);
    expect(r.errors[0]!.message).toMatch(/64 KiB|too large/i);
  });

  it("collects parse errors per file but keeps loading the rest", async () => {
    const deps = makeDeps({
      "/u/agents": { kind: "dir", entries: ["good.md", "bad.md"] },
      "/u/agents/good.md": { kind: "file", content: VALID },
      "/u/agents/bad.md": { kind: "file", content: "not yaml\n" },
    });
    const r = await loadFromDirs({ userDir: "/u/agents", projectDir: "/p/agents", deps });
    expect(r.manifests.length).toBe(1);
    expect(r.errors.length).toBe(1);
  });

  it("detects symlink cycle and reports it", async () => {
    const deps = makeDeps({
      "/u/agents": { kind: "dir", entries: ["link.md"] },
      "/u/agents/link.md": { kind: "file", content: VALID, isSymlink: true, realPath: "/u/agents/link.md" },
    });
    const r = await loadFromDirs({ userDir: "/u/agents", projectDir: "/p/agents", deps });
    // Cycle: realpath = same path → skip.
    expect(r.manifests).toEqual([]);
    expect(r.errors.some((e) => /cycle|symlink/i.test(e.message))).toBe(true);
  });

  it("ignores non-.md files", async () => {
    const deps = makeDeps({
      "/u/agents": { kind: "dir", entries: ["a.md", "README.txt"] },
      "/u/agents/a.md": { kind: "file", content: VALID },
      "/u/agents/README.txt": { kind: "file", content: "ignored" },
    });
    const r = await loadFromDirs({ userDir: "/u/agents", projectDir: "/p/agents", deps });
    expect(r.manifests.length).toBe(1);
  });

  it("missing dirs are not errors", async () => {
    const deps = makeDeps({});
    const r = await loadFromDirs({ userDir: "/u/agents", projectDir: "/p/agents", deps });
    expect(r.manifests).toEqual([]);
    expect(r.errors).toEqual([]);
  });
});

describe("recursive walk", () => {
  function makeFakeDeps(fs: Record<string, { kind: "dir"; entries: string[] } | { kind: "file"; text: string }>) {
    return {
      readDir: async (p: string) => {
        const node = fs[p];
        if (!node) { const e: any = new Error(`ENOENT: ${p}`); e.code = "ENOENT"; throw e; }
        if (node.kind !== "dir") throw new Error(`not a dir: ${p}`);
        return node.entries;
      },
      stat: async (p: string) => {
        const node = fs[p];
        if (!node) { const e: any = new Error(`ENOENT: ${p}`); e.code = "ENOENT"; throw e; }
        return {
          isFile: () => node.kind === "file",
          isDirectory: () => node.kind === "dir",
          isSymbolicLink: () => false,
          size: node.kind === "file" ? Buffer.byteLength(node.text, "utf8") : 0,
        };
      },
      realpath: async (p: string) => p,
      readFile: async (p: string) => {
        const node = fs[p];
        if (!node || node.kind !== "file") throw new Error(`not a file: ${p}`);
        return node.text;
      },
    };
  }

  const goodMd = (name: string) => `---
name: ${name}
description: An agent.
---
body for ${name}`;

  it("loads agents from nested subdirectories", async () => {
    const fs = {
      "/user": { kind: "dir" as const, entries: ["sub", "top.md"] },
      "/user/top.md": { kind: "file" as const, text: goodMd("top") },
      "/user/sub": { kind: "dir" as const, entries: ["deep.md"] },
      "/user/sub/deep.md": { kind: "file" as const, text: goodMd("deep") },
      "/project": { kind: "dir" as const, entries: [] },
    };
    const result = await loadFromDirs({ userDir: "/user", projectDir: "/project", deps: makeFakeDeps(fs) });
    expect(result.manifests.map((m) => m.name).sort()).toEqual(["deep", "top"]);
    expect(result.errors).toEqual([]);
  });

  it("identity comes from frontmatter name only — path does not influence identity", async () => {
    const fs = {
      "/user": { kind: "dir" as const, entries: ["a"] },
      "/user/a": { kind: "dir" as const, entries: ["x.md"] },
      "/user/a/x.md": { kind: "file" as const, text: goodMd("coder") },
      "/project": { kind: "dir" as const, entries: [] },
    };
    const result = await loadFromDirs({ userDir: "/user", projectDir: "/project", deps: makeFakeDeps(fs) });
    expect(result.manifests).toHaveLength(1);
    expect(result.manifests[0]!.name).toBe("coder");
    expect(result.manifests[0]!.sourcePath).toBe("/user/a/x.md");
  });

  it("skips hidden directories", async () => {
    const fs = {
      "/user": { kind: "dir" as const, entries: [".git", "good.md"] },
      "/user/good.md": { kind: "file" as const, text: goodMd("good") },
      "/user/.git": { kind: "dir" as const, entries: ["agents"] },
      "/user/.git/agents": { kind: "dir" as const, entries: ["hidden.md"] },
      "/user/.git/agents/hidden.md": { kind: "file" as const, text: goodMd("hidden") },
      "/project": { kind: "dir" as const, entries: [] },
    };
    const result = await loadFromDirs({ userDir: "/user", projectDir: "/project", deps: makeFakeDeps(fs) });
    expect(result.manifests.map((m) => m.name)).toEqual(["good"]);
    expect(result.errors).toEqual([]);
  });

  it("errors when directory depth exceeds 8", async () => {
    const fs: any = { "/project": { kind: "dir", entries: [] } };
    let path = "/user";
    fs[path] = { kind: "dir", entries: ["sub"] };
    for (let depth = 1; depth <= 10; depth++) {
      const next = `${path}/sub`;
      fs[path] = { kind: "dir", entries: ["sub", "f.md"] };
      fs[`${path}/f.md`] = { kind: "file", text: goodMd(`level${depth - 1}`) };
      fs[next] = { kind: "dir", entries: [] };
      path = next;
    }
    fs[path] = { kind: "dir", entries: [] };
    const result = await loadFromDirs({ userDir: "/user", projectDir: "/project", deps: makeFakeDeps(fs) });
    expect(result.manifests.length).toBeLessThanOrEqual(8);
    expect(result.errors.some((e) => /directory depth exceeds 8/.test(e.message))).toBe(true);
  });

  it("falls back to lex-order across subdirs on name collision", async () => {
    const fs = {
      "/user": { kind: "dir" as const, entries: ["a", "b"] },
      "/user/a": { kind: "dir" as const, entries: ["coder.md"] },
      "/user/a/coder.md": { kind: "file" as const, text: goodMd("coder") },
      "/user/b": { kind: "dir" as const, entries: ["coder.md"] },
      "/user/b/coder.md": { kind: "file" as const, text: goodMd("coder") },
      "/project": { kind: "dir" as const, entries: [] },
    };
    const result = await loadFromDirs({ userDir: "/user", projectDir: "/project", deps: makeFakeDeps(fs) });
    expect(result.manifests).toHaveLength(1);
    expect(result.manifests[0]!.sourcePath).toBe("/user/a/coder.md");
    expect(result.errors.some((e) => /duplicate agent name 'coder'/.test(e.message))).toBe(true);
  });

  it("propagates per-file failures from inside subdirs", async () => {
    const oversized = "x".repeat(70 * 1024);
    const fs = {
      "/user": { kind: "dir" as const, entries: ["sub"] },
      "/user/sub": { kind: "dir" as const, entries: ["big.md", "missing-fm.md", "ok.md"] },
      "/user/sub/big.md": { kind: "file" as const, text: `---\nname: big\ndescription: x\n---\n${oversized}` },
      "/user/sub/missing-fm.md": { kind: "file" as const, text: "no frontmatter here" },
      "/user/sub/ok.md": { kind: "file" as const, text: goodMd("ok") },
      "/project": { kind: "dir" as const, entries: [] },
    };
    const result = await loadFromDirs({ userDir: "/user", projectDir: "/project", deps: makeFakeDeps(fs) });
    expect(result.manifests.map((m) => m.name)).toEqual(["ok"]);
    expect(result.errors.some((e) => /exceeds 64 KiB/.test(e.message))).toBe(true);
    expect(result.errors.some((e) => /missing YAML frontmatter/.test(e.message))).toBe(true);
  });
});
