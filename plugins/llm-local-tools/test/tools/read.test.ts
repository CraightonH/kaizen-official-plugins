// plugins/llm-local-tools/test/tools/read.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, truncateSync, openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schema, handler } from "../../tools/read.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "llt-read-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const ctx = { signal: new AbortController().signal, callId: "c1", log: () => {} } as any;

describe("read tool", () => {
  it("schema metadata is correct", () => {
    expect(schema.name).toBe("read");
    expect(schema.tags).toEqual(["local", "fs"]);
    expect(schema.parameters.required).toEqual(["path"]);
  });

  it("returns line-numbered content", async () => {
    const p = join(dir, "a.txt");
    writeFileSync(p, "first\nsecond\nthird");
    const out = await handler({ path: p }, ctx) as string;
    expect(out).toContain("     1\tfirst");
    expect(out).toContain("     2\tsecond");
    expect(out).toContain("     3\tthird");
  });

  it("honors offset and limit", async () => {
    const p = join(dir, "b.txt");
    writeFileSync(p, Array.from({ length: 10 }, (_, i) => `L${i + 1}`).join("\n"));
    const out = await handler({ path: p, offset: 3, limit: 2 }, ctx) as string;
    expect(out).toContain("     3\tL3");
    expect(out).toContain("     4\tL4");
    expect(out).not.toContain("L5");
    expect(out).not.toContain("L1");
  });

  it("rejects binary files (NUL byte in first 8KB)", async () => {
    const p = join(dir, "bin");
    writeFileSync(p, Buffer.concat([Buffer.from("hi"), Buffer.from([0]), Buffer.from("more")]));
    await expect(handler({ path: p }, ctx)).rejects.toThrow(/binary/i);
  });

  it("throws ENOENT-shaped error for missing path", async () => {
    await expect(handler({ path: join(dir, "missing.txt") }, ctx))
      .rejects.toThrow(/ENOENT.*missing\.txt/);
  });

  it("refuses files larger than MAX_READ_BYTES", async () => {
    const p = join(dir, "huge");
    const fd = openSync(p, "w");
    closeSync(fd);
    truncateSync(p, 51 * 1024 * 1024); // sparse 51 MB
    await expect(handler({ path: p }, ctx)).rejects.toThrow(/too large/i);
  });

  it("appends truncation marker when over READ_CAP_LINES", async () => {
    const p = join(dir, "big.txt");
    const lines = Array.from({ length: 2100 }, (_, i) => `L${i + 1}`).join("\n");
    writeFileSync(p, lines);
    const out = await handler({ path: p }, ctx) as string;
    expect(out).toMatch(/\[truncated: file has \d+ more lines/);
  });
});
