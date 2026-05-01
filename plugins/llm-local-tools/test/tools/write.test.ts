// plugins/llm-local-tools/test/tools/write.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schema, handler } from "../../tools/write.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "llt-write-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const ctx = { signal: new AbortController().signal, callId: "c1", log: () => {} } as any;

describe("write tool", () => {
  it("schema metadata", () => {
    expect(schema.name).toBe("write");
    expect(schema.tags).toEqual(["local", "fs"]);
  });

  it("overwrites an existing file", async () => {
    const p = join(dir, "a.txt");
    writeFileSync(p, "old");
    const out = await handler({ path: p, content: "new" }, ctx) as string;
    expect(readFileSync(p, "utf8")).toBe("new");
    expect(out).toMatch(/wrote 3 bytes to /);
  });

  it("refuses if file does not exist", async () => {
    await expect(handler({ path: join(dir, "missing.txt"), content: "x" }, ctx))
      .rejects.toThrow(/does not exist/i);
  });

  it("refuses if parent directory missing", async () => {
    await expect(handler({ path: join(dir, "no/such/parent/file.txt"), content: "x" }, ctx))
      .rejects.toThrow(/parent directory/i);
  });

  it("UTF-8 round trip preserved verbatim", async () => {
    const p = join(dir, "utf.txt");
    writeFileSync(p, "");
    await handler({ path: p, content: "héllo\n" }, ctx);
    expect(readFileSync(p, "utf8")).toBe("héllo\n");
  });
});
