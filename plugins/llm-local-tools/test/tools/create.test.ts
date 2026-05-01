// plugins/llm-local-tools/test/tools/create.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schema, handler } from "../../tools/create.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "llt-create-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const ctx = { signal: new AbortController().signal, callId: "c1", log: () => {} } as any;

describe("create tool", () => {
  it("schema metadata", () => {
    expect(schema.name).toBe("create");
    expect(schema.tags).toEqual(["local", "fs"]);
  });

  it("creates a new file", async () => {
    const p = join(dir, "new.txt");
    const out = await handler({ path: p, content: "hi" }, ctx) as string;
    expect(existsSync(p)).toBe(true);
    expect(readFileSync(p, "utf8")).toBe("hi");
    expect(out).toMatch(/wrote 2 bytes to /);
  });

  it("refuses if file exists", async () => {
    const p = join(dir, "x.txt");
    writeFileSync(p, "old");
    await expect(handler({ path: p, content: "new" }, ctx)).rejects.toThrow(/already exists/i);
    expect(readFileSync(p, "utf8")).toBe("old");
  });

  it("refuses if parent missing", async () => {
    await expect(handler({ path: join(dir, "deep/sub/x.txt"), content: "z" }, ctx))
      .rejects.toThrow(/parent directory/i);
  });
});
