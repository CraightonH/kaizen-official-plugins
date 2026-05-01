// plugins/llm-local-tools/test/tools/edit.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schema, handler } from "../../tools/edit.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "llt-edit-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const ctx = { signal: new AbortController().signal, callId: "c1", log: () => {} } as any;

describe("edit tool", () => {
  it("schema metadata", () => {
    expect(schema.name).toBe("edit");
    expect(schema.tags).toEqual(["local", "fs"]);
  });

  it("replaces a unique match", async () => {
    const p = join(dir, "a.txt"); writeFileSync(p, "alpha BETA gamma");
    const out = await handler({ path: p, old_string: "BETA", new_string: "DELTA" }, ctx) as string;
    expect(readFileSync(p, "utf8")).toBe("alpha DELTA gamma");
    expect(out).toMatch(/replaced 1 occurrence/);
  });

  it("rejects zero matches", async () => {
    const p = join(dir, "a.txt"); writeFileSync(p, "alpha");
    await expect(handler({ path: p, old_string: "ZZ", new_string: "Y" }, ctx))
      .rejects.toThrow(/not found/i);
  });

  it("rejects multi-match without replace_all", async () => {
    const p = join(dir, "a.txt"); writeFileSync(p, "x x x");
    await expect(handler({ path: p, old_string: "x", new_string: "y" }, ctx))
      .rejects.toThrow(/matched 3 times/i);
  });

  it("replace_all replaces all", async () => {
    const p = join(dir, "a.txt"); writeFileSync(p, "x x x");
    const out = await handler({ path: p, old_string: "x", new_string: "y", replace_all: true }, ctx) as string;
    expect(readFileSync(p, "utf8")).toBe("y y y");
    expect(out).toMatch(/replaced 3 occurrence/);
  });

  it("rejects identical old/new", async () => {
    const p = join(dir, "a.txt"); writeFileSync(p, "alpha");
    await expect(handler({ path: p, old_string: "alpha", new_string: "alpha" }, ctx))
      .rejects.toThrow(/no-op/i);
  });

  it("whitespace-sensitive match", async () => {
    const p = join(dir, "a.txt"); writeFileSync(p, "  indented");
    await expect(handler({ path: p, old_string: "indented", new_string: "X" }, ctx))
      .resolves.toBeDefined();
    expect(readFileSync(p, "utf8")).toBe("  X");
  });

  it("missing file throws", async () => {
    await expect(handler({ path: join(dir, "missing"), old_string: "a", new_string: "b" }, ctx))
      .rejects.toThrow(/ENOENT/);
  });
});
