// plugins/llm-local-tools/test/util.test.ts
import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolvePath,
  truncateBytes,
  truncateMiddle,
  sniffBinary,
  ensureParentExists,
  hasGitRoot,
  formatLineNumbered,
  MAX_READ_BYTES,
  READ_CAP_BYTES,
  READ_CAP_LINES,
  BASH_OUTPUT_CAP,
  GREP_DEFAULT_MAX,
  GLOB_CAP,
} from "../util.ts";

describe("util", () => {
  it("constants match spec", () => {
    expect(MAX_READ_BYTES).toBe(50 * 1024 * 1024);
    expect(READ_CAP_BYTES).toBe(256 * 1024);
    expect(READ_CAP_LINES).toBe(2000);
    expect(BASH_OUTPUT_CAP).toBe(256 * 1024);
    expect(GREP_DEFAULT_MAX).toBe(200);
    expect(GLOB_CAP).toBe(1000);
  });

  it("resolvePath returns absolute paths against baseCwd", () => {
    expect(resolvePath("/abs/path")).toBe("/abs/path");
    expect(resolvePath("rel/x", "/base")).toBe("/base/rel/x");
  });

  it("truncateBytes appends marker once over cap", () => {
    const s = "x".repeat(100);
    const out = truncateBytes(s, 10, "[truncated: cap]");
    expect(out.startsWith("xxxxxxxxxx")).toBe(true);
    expect(out).toContain("[truncated: cap]");
    expect(truncateBytes("hi", 10, "...")).toBe("hi");
  });

  it("truncateMiddle keeps head + tail with marker", () => {
    const s = "A".repeat(50) + "B".repeat(50) + "C".repeat(50);
    const out = truncateMiddle(s, 40, "[mid]");
    expect(out.startsWith("A")).toBe(true);
    expect(out.endsWith("C")).toBe(true);
    expect(out).toContain("[mid]");
    expect(out.length).toBeLessThan(s.length);
    expect(truncateMiddle("short", 100, "[mid]")).toBe("short");
  });

  it("sniffBinary detects NUL in first 8KB", () => {
    expect(sniffBinary(Buffer.from("hello world"))).toBe(false);
    const withNul = Buffer.concat([Buffer.from("ok"), Buffer.from([0]), Buffer.from("more")]);
    expect(sniffBinary(withNul)).toBe(true);
  });

  it("ensureParentExists throws when parent missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "llt-"));
    try {
      await ensureParentExists(join(dir, "exists.txt"));
      await expect(ensureParentExists(join(dir, "missing/exists.txt"))).rejects.toThrow(/parent directory/i);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("hasGitRoot walks up to find .git", () => {
    const root = mkdtempSync(join(tmpdir(), "llt-git-"));
    try {
      mkdirSync(join(root, ".git"));
      mkdirSync(join(root, "a/b"), { recursive: true });
      expect(hasGitRoot(join(root, "a/b"))).toBe(true);
      const naked = mkdtempSync(join(tmpdir(), "llt-nogit-"));
      try {
        expect(hasGitRoot(naked)).toBe(false);
      } finally {
        rmSync(naked, { recursive: true });
      }
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it("formatLineNumbered produces cat -n style", () => {
    const out = formatLineNumbered("a\nb\nc", 1);
    expect(out).toBe("     1\ta\n     2\tb\n     3\tc");
    const offset = formatLineNumbered("x\ny", 10);
    expect(offset).toBe("    10\tx\n    11\ty");
  });
});
