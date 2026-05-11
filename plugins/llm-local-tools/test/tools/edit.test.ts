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

describe("edit tool — str_replace", () => {
  it("schema metadata", () => {
    expect(schema.name).toBe("edit");
    expect(schema.tags).toEqual(["local", "fs"]);
  });

  it("replaces a unique match", async () => {
    const p = join(dir, "a.txt"); writeFileSync(p, "alpha BETA gamma");
    const out = await handler({ command: "str_replace", path: p, old_str: "BETA", new_str: "DELTA" }, ctx) as string;
    expect(readFileSync(p, "utf8")).toBe("alpha DELTA gamma");
    expect(out).toMatch(/replaced 1 occurrence/);
  });

  it("rejects zero matches", async () => {
    const p = join(dir, "a.txt"); writeFileSync(p, "alpha");
    await expect(handler({ command: "str_replace", path: p, old_str: "ZZ", new_str: "Y" }, ctx))
      .rejects.toThrow(/not found/i);
  });

  it("rejects multi-match without replace_all", async () => {
    const p = join(dir, "a.txt"); writeFileSync(p, "x x x");
    await expect(handler({ command: "str_replace", path: p, old_str: "x", new_str: "y" }, ctx))
      .rejects.toThrow(/matched 3 times/i);
  });

  it("replace_all replaces all", async () => {
    const p = join(dir, "a.txt"); writeFileSync(p, "x x x");
    const out = await handler({ command: "str_replace", path: p, old_str: "x", new_str: "y", replace_all: true }, ctx) as string;
    expect(readFileSync(p, "utf8")).toBe("y y y");
    expect(out).toMatch(/replaced 3 occurrence/);
  });

  it("rejects identical old/new", async () => {
    const p = join(dir, "a.txt"); writeFileSync(p, "alpha");
    await expect(handler({ command: "str_replace", path: p, old_str: "alpha", new_str: "alpha" }, ctx))
      .rejects.toThrow(/no-op/i);
  });

  it("whitespace-sensitive match", async () => {
    const p = join(dir, "a.txt"); writeFileSync(p, "  indented");
    await expect(handler({ command: "str_replace", path: p, old_str: "indented", new_str: "X" }, ctx))
      .resolves.toBeDefined();
    expect(readFileSync(p, "utf8")).toBe("  X");
  });

  it("missing file throws", async () => {
    await expect(handler({ command: "str_replace", path: join(dir, "missing"), old_str: "a", new_str: "b" }, ctx))
      .rejects.toThrow(/ENOENT/);
  });

  it("rejects empty old_str with a directive error", async () => {
    const p = join(dir, "a.txt"); writeFileSync(p, "alpha");
    await expect(handler({ command: "str_replace", path: p, old_str: "", new_str: "Y" }, ctx))
      .rejects.toThrow(/old_str must be non-empty/);
  });

  it("rejects missing old_str with a self-teaching error", async () => {
    const p = join(dir, "a.txt"); writeFileSync(p, "alpha");
    await expect(handler({ command: "str_replace", path: p, new_str: "Y" } as any, ctx))
      .rejects.toThrow(/old_str is required when command="str_replace"/);
    await expect(handler({ command: "str_replace", path: p, new_str: "Y" } as any, ctx))
      .rejects.toThrow(/command="insert"/);
  });

  it("rejects missing new_str with a self-teaching error", async () => {
    const p = join(dir, "a.txt"); writeFileSync(p, "alpha");
    await expect(handler({ command: "str_replace", path: p, old_str: "alpha" } as any, ctx))
      .rejects.toThrow(/new_str is required when command="str_replace"/);
  });
});

describe("edit tool — insert (1-based AT semantics)", () => {
  it("prepends when insert_line is 1", async () => {
    const p = join(dir, "a.txt"); writeFileSync(p, "alpha\nbeta\n");
    await handler({ command: "insert", path: p, insert_line: 1, insert_text: "ZERO\n" }, ctx);
    expect(readFileSync(p, "utf8")).toBe("ZERO\nalpha\nbeta\n");
  });

  it("appends when insert_line equals file_line_count + 1", async () => {
    const p = join(dir, "a.txt"); writeFileSync(p, "alpha\nbeta\n");
    await handler({ command: "insert", path: p, insert_line: 3, insert_text: "GAMMA\n" }, ctx);
    expect(readFileSync(p, "utf8")).toBe("alpha\nbeta\nGAMMA\n");
  });

  it("inserts at line N in the middle (existing line N shifts down)", async () => {
    const p = join(dir, "a.txt"); writeFileSync(p, "alpha\nbeta\ngamma\n");
    await handler({ command: "insert", path: p, insert_line: 2, insert_text: "MID\n" }, ctx);
    expect(readFileSync(p, "utf8")).toBe("alpha\nMID\nbeta\ngamma\n");
  });

  it("preserves trailing-newline absence when appending verbatim", async () => {
    const p = join(dir, "a.txt"); writeFileSync(p, "alpha\nbeta"); // no trailing \n; line count = 2
    await handler({ command: "insert", path: p, insert_line: 3, insert_text: "GAMMA" }, ctx);
    expect(readFileSync(p, "utf8")).toBe("alpha\nbetaGAMMA");
  });

  it("rejects insert_line past EOF with a self-teaching error", async () => {
    const p = join(dir, "a.txt"); writeFileSync(p, "alpha\nbeta\n"); // 2 lines, valid 1..3
    await expect(handler({ command: "insert", path: p, insert_line: 4, insert_text: "X" }, ctx))
      .rejects.toThrow(/insert_line 4 out of range for 2-line file \(valid: 1\.\.3\)/);
  });

  it("rejects insert_line below 1 with a self-teaching error", async () => {
    const p = join(dir, "a.txt"); writeFileSync(p, "x\n");
    await expect(handler({ command: "insert", path: p, insert_line: 0, insert_text: "X" }, ctx))
      .rejects.toThrow(/insert_line must be an integer in 1\.\.2/);
  });

  it("rejects negative insert_line", async () => {
    const p = join(dir, "a.txt"); writeFileSync(p, "x\n");
    await expect(handler({ command: "insert", path: p, insert_line: -1, insert_text: "X" }, ctx))
      .rejects.toThrow(/insert_line must be an integer in 1\.\.2/);
  });

  it("rejects missing insert_line with a required-field error", async () => {
    const p = join(dir, "a.txt"); writeFileSync(p, "x\n");
    await expect(handler({ command: "insert", path: p, insert_text: "X" } as any, ctx))
      .rejects.toThrow(/insert_line is required when command="insert"/);
  });

  it("rejects empty insert_text", async () => {
    const p = join(dir, "a.txt"); writeFileSync(p, "x\n");
    await expect(handler({ command: "insert", path: p, insert_line: 1, insert_text: "" }, ctx))
      .rejects.toThrow(/insert_text must be non-empty/);
  });

  it("missing file throws ENOENT", async () => {
    await expect(handler({ command: "insert", path: join(dir, "missing"), insert_line: 1, insert_text: "x" }, ctx))
      .rejects.toThrow(/ENOENT/);
  });

  it("inserts into an empty file when insert_line is 1", async () => {
    const p = join(dir, "a.txt"); writeFileSync(p, ""); // 0 lines; valid range 1..1
    await handler({ command: "insert", path: p, insert_line: 1, insert_text: "first\n" }, ctx);
    expect(readFileSync(p, "utf8")).toBe("first\n");
  });

  it("rejects insert_line: 2 on an empty file (out of range)", async () => {
    const p = join(dir, "a.txt"); writeFileSync(p, "");
    await expect(handler({ command: "insert", path: p, insert_line: 2, insert_text: "x" }, ctx))
      .rejects.toThrow(/insert_line 2 out of range for 0-line file \(valid: 1\.\.1\)/);
  });
});

describe("edit tool — dispatcher", () => {
  it("rejects unknown command", async () => {
    const p = join(dir, "a.txt"); writeFileSync(p, "x");
    await expect(handler({ command: "delete_lines", path: p } as any, ctx))
      .rejects.toThrow(/unknown command/);
  });

  it("rejects missing command", async () => {
    const p = join(dir, "a.txt"); writeFileSync(p, "x");
    await expect(handler({ path: p } as any, ctx))
      .rejects.toThrow(/unknown command/);
  });
});
