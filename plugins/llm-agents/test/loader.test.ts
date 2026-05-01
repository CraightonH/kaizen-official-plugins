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
