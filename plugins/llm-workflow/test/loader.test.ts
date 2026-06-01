import { describe, it, expect } from "bun:test";
import { loadFromDirs } from "../loader.ts";

function makeFs(files: Record<string, string>) {
  const entries: Record<string, string[]> = {};
  for (const path of Object.keys(files)) {
    let dir = path.substring(0, path.lastIndexOf("/"));
    while (dir.length > 0) {
      const parent = dir.substring(0, dir.lastIndexOf("/"));
      entries[dir] ??= [];
      const child = dir.substring(parent.length + 1);
      if (parent !== "" && !(entries[parent] ?? []).includes(child)) {
        entries[parent] ??= [];
        entries[parent]!.push(child);
      }
      const name = path.substring(dir.length + 1);
      if (!entries[dir]!.includes(name)) entries[dir]!.push(name);
      if (parent === "") break;
      dir = parent;
    }
  }
  return {
    readDir: async (p: string) => entries[p] ? [...entries[p]] : (() => { const e: any = new Error("ENOENT"); e.code = "ENOENT"; throw e; })(),
    stat: async (p: string) => ({
      isFile: () => files[p] !== undefined,
      isDirectory: () => entries[p] !== undefined,
      isSymbolicLink: () => false,
      size: files[p] ? Buffer.byteLength(files[p]!, "utf8") : 0,
    }),
    realpath: async (p: string) => p,
    readFile: async (p: string) => { const v = files[p]; if (v === undefined) throw new Error("ENOENT"); return v; },
  };
}

const validSrc = (name: string) => `export const meta = { name: "${name}", description: "Desc ${name}" };\n`;

describe("loadFromDirs", () => {
  it("discovers .ts files from both scopes; project shadows user", async () => {
    const fs = makeFs({
      "/u/foo.ts": validSrc("foo"),
      "/u/bar.ts": validSrc("bar"),
      "/p/bar.ts": validSrc("bar"), // shadow
    });
    const res = await loadFromDirs({ userDir: "/u", projectDir: "/p", deps: fs });
    const byName = Object.fromEntries(res.manifests.map((m) => [m.meta.name, m]));
    expect(Object.keys(byName).sort()).toEqual(["bar", "foo"]);
    expect(byName.bar!.scope).toBe("project");
    expect(byName.foo!.scope).toBe("user");
  });

  it("skips non-.ts files", async () => {
    const fs = makeFs({
      "/u/foo.ts": validSrc("foo"),
      "/u/skip.md": "ignore me",
      "/u/skip.json": "{}",
    });
    const res = await loadFromDirs({ userDir: "/u", projectDir: "/p", deps: fs });
    expect(res.manifests.length).toBe(1);
    expect(res.manifests[0]!.meta.name).toBe("foo");
  });

  it("rejects files exceeding maxFileBytes", async () => {
    const big = "x".repeat(70_000);
    const fs = makeFs({ "/u/foo.ts": validSrc("foo") + big });
    const res = await loadFromDirs({ userDir: "/u", projectDir: "/p", deps: fs, maxFileBytes: 65536 });
    expect(res.manifests.length).toBe(0);
    expect(res.errors[0]!.message).toMatch(/exceeds .* cap/);
  });

  it("rejects filename-mismatch", async () => {
    const fs = makeFs({ "/u/foo.ts": validSrc("bar") });
    const res = await loadFromDirs({ userDir: "/u", projectDir: "/p", deps: fs });
    expect(res.manifests.length).toBe(0);
    expect(res.errors[0]!.message).toMatch(/filename basename/);
  });

  it("captures meta-parse errors per file without poisoning others", async () => {
    const fs = makeFs({
      "/u/ok.ts": validSrc("ok"),
      "/u/bad.ts": `export const meta = { description: "missing name" };`,
    });
    const res = await loadFromDirs({ userDir: "/u", projectDir: "/p", deps: fs });
    expect(res.manifests.length).toBe(1);
    expect(res.manifests[0]!.meta.name).toBe("ok");
    expect(res.errors.length).toBe(1);
  });
});
