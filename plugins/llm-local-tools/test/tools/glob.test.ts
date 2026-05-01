// plugins/llm-local-tools/test/tools/glob.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schema, handler } from "../../tools/glob.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "llt-glob-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const ctx = { signal: new AbortController().signal, callId: "c1", log: () => {} } as any;

describe("glob tool", () => {
  it("schema metadata", () => {
    expect(schema.name).toBe("glob");
    expect(schema.tags).toEqual(["local", "fs"]);
  });

  it("matches **/*.ts and sorts by mtime desc", async () => {
    writeFileSync(join(dir, "a.ts"), "");
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub/b.ts"), "");
    const now = new Date();
    utimesSync(join(dir, "a.ts"), now, new Date(now.getTime() - 60_000));
    utimesSync(join(dir, "sub/b.ts"), now, now);
    const out = await handler({ pattern: "**/*.ts", cwd: dir }, ctx) as string;
    const lines = out.split("\n").filter(Boolean);
    expect(lines[0]).toContain("sub/b.ts");
    expect(lines[1]).toContain("a.ts");
  });

  it("honors .gitignore when .git is present at root", async () => {
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".gitignore"), "*.log\n");
    writeFileSync(join(dir, "ignored.log"), "");
    writeFileSync(join(dir, "kept.ts"), "");
    const out = await handler({ pattern: "**/*", cwd: dir }, ctx) as string;
    expect(out).toContain("kept.ts");
    expect(out).not.toContain("ignored.log");
  });

  it("ignores .gitignore when no .git is present", async () => {
    writeFileSync(join(dir, ".gitignore"), "*.log\n");
    writeFileSync(join(dir, "ignored.log"), "");
    writeFileSync(join(dir, "kept.ts"), "");
    const out = await handler({ pattern: "**/*", cwd: dir }, ctx) as string;
    expect(out).toContain("kept.ts");
    expect(out).toContain("ignored.log");
  });

  it("truncates above GLOB_CAP", async () => {
    for (let i = 0; i < 1005; i++) writeFileSync(join(dir, `f${i}.txt`), "");
    const out = await handler({ pattern: "*.txt", cwd: dir }, ctx) as string;
    expect(out).toMatch(/\[truncated: \d+ more matches\]/);
    const lines = out.split("\n").filter(Boolean);
    expect(lines.length).toBe(1001); // 1000 paths + 1 marker line
  });
});
