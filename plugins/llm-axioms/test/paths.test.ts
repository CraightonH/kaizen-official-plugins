import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, existsSync, writeFileSync, statSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAxiomsDir, ensureDir, sessionFilePath, sweepStaleTempFiles } from "../paths.ts";

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "llm-axioms-paths-")); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe("resolveAxiomsDir", () => {
  it("expands ~/ against home", () => {
    expect(resolveAxiomsDir({ home: "/home/test", configured: "~/foo/bar" })).toBe("/home/test/foo/bar");
  });
  it("returns absolute paths unchanged", () => {
    expect(resolveAxiomsDir({ home: "/x", configured: "/abs/path" })).toBe("/abs/path");
  });
  it("falls back to default when configured is empty", () => {
    expect(resolveAxiomsDir({ home: "/h", configured: "" })).toBe("/h/.kaizen/plugins/llm-axioms/sessions");
  });
});

describe("ensureDir", () => {
  it("creates a missing dir, idempotent", async () => {
    const p = join(tmp, "a/b/c");
    await ensureDir(p);
    expect(existsSync(p)).toBe(true);
    await ensureDir(p);
    expect(existsSync(p)).toBe(true);
  });
});

describe("sessionFilePath", () => {
  it("joins dir + session id + .json", () => {
    expect(sessionFilePath("/x/y", "abc")).toBe("/x/y/abc.json");
  });
});

describe("sweepStaleTempFiles", () => {
  it("removes .tmp.* files older than the threshold", async () => {
    await ensureDir(tmp);
    const stale = join(tmp, "x.json.tmp.123.abc");
    const fresh = join(tmp, "y.json.tmp.999.def");
    writeFileSync(stale, "old");
    writeFileSync(fresh, "new");
    // Backdate the stale file's mtime.
    const past = new Date(Date.now() - 120_000);
    require("node:fs").utimesSync(stale, past, past);
    await sweepStaleTempFiles(tmp, 60_000);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });
  it("leaves non-tmp files alone", async () => {
    await ensureDir(tmp);
    const keep = join(tmp, "abc.json");
    writeFileSync(keep, "real");
    require("node:fs").utimesSync(keep, new Date(0), new Date(0));
    await sweepStaleTempFiles(tmp, 60_000);
    expect(existsSync(keep)).toBe(true);
  });
  it("no-ops on missing dir", async () => {
    await sweepStaleTempFiles(join(tmp, "missing"), 60_000);
  });
});
