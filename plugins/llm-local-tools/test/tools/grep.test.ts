// plugins/llm-local-tools/test/tools/grep.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { schema, makeHandler } from "../../tools/grep.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "llt-grep-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const ctx = { signal: new AbortController().signal, callId: "c1", log: () => {} } as any;

// Use the JS-fallback handler for deterministic tests across environments.
const handler = makeHandler({ rgPath: null });


describe("grep tool", () => {
  it("schema metadata", () => {
    expect(schema.name).toBe("grep");
    expect(schema.tags).toEqual(["local", "fs"]);
  });

  it("content mode returns file:line:content", async () => {
    writeFileSync(join(dir, "a.ts"), "alpha\nbeta hello world\ngamma");
    writeFileSync(join(dir, "b.ts"), "no match here");
    const out = await handler({ pattern: "hello", path: dir }, ctx) as string;
    expect(out).toMatch(/a\.ts:2:beta hello world/);
    expect(out).not.toMatch(/b\.ts/);
  });

  it("output_mode files_with_matches", async () => {
    writeFileSync(join(dir, "a.ts"), "x match");
    writeFileSync(join(dir, "b.ts"), "y match");
    const out = await handler({ pattern: "match", path: dir, output_mode: "files_with_matches" }, ctx) as string;
    const lines = out.split("\n").sort();
    expect(lines.length).toBe(2);
    expect(lines[0]).toMatch(/a\.ts$/);
    expect(lines[1]).toMatch(/b\.ts$/);
  });

  it("output_mode count returns one number per file", async () => {
    writeFileSync(join(dir, "a.ts"), "x\nx\ny");
    const out = await handler({ pattern: "x", path: dir, output_mode: "count" }, ctx) as string;
    expect(out).toMatch(/a\.ts:2/);
  });

  it("glob filter restricts files", async () => {
    writeFileSync(join(dir, "a.ts"), "match");
    writeFileSync(join(dir, "b.txt"), "match");
    const out = await handler({ pattern: "match", path: dir, glob: "*.ts" }, ctx) as string;
    expect(out).toMatch(/a\.ts/);
    expect(out).not.toMatch(/b\.txt/);
  });

  it("case_insensitive", async () => {
    writeFileSync(join(dir, "a.ts"), "Hello");
    const out = await handler({ pattern: "hello", path: dir, case_insensitive: true }, ctx) as string;
    expect(out).toMatch(/Hello/);
  });

  it("context lines included in content mode", async () => {
    writeFileSync(join(dir, "a.ts"), "L1\nL2 match\nL3");
    const out = await handler({ pattern: "match", path: dir, context: 1 }, ctx) as string;
    expect(out).toMatch(/L1/);
    expect(out).toMatch(/L3/);
  });

  it("max_results caps content mode", async () => {
    writeFileSync(join(dir, "a.ts"), Array.from({ length: 500 }, (_, i) => `match-${i}`).join("\n"));
    const out = await handler({ pattern: "match", path: dir, max_results: 10 }, ctx) as string;
    const lines = out.split("\n").filter(Boolean);
    expect(lines.length).toBeLessThanOrEqual(11); // 10 + possible truncation marker
  });
});

// Run the rg path only when ripgrep is actually on PATH so CI without rg still passes.
const rgProbe = spawnSync("which", ["rg"], { encoding: "utf8" });
const rgPath = rgProbe.status === 0 ? rgProbe.stdout.trim() : null;

(rgPath ? describe : describe.skip)("grep tool — ripgrep path", () => {
  const rgHandler = makeHandler({ rgPath: rgPath! });

  it("content mode returns file:line:content via rg", async () => {
    writeFileSync(join(dir, "a.ts"), "alpha\nbeta hello world\ngamma");
    writeFileSync(join(dir, "b.ts"), "no match here");
    const out = await rgHandler({ pattern: "hello", path: dir }, ctx) as string;
    expect(out).toMatch(/a\.ts:2:beta hello world/);
    expect(out).not.toMatch(/b\.ts/);
  });

  it("files_with_matches mode via rg", async () => {
    writeFileSync(join(dir, "a.ts"), "match");
    writeFileSync(join(dir, "b.ts"), "match");
    writeFileSync(join(dir, "c.ts"), "nope");
    const out = await rgHandler({ pattern: "match", path: dir, output_mode: "files_with_matches" }, ctx) as string;
    const lines = out.split("\n").filter(Boolean).sort();
    expect(lines.length).toBe(2);
    expect(lines[0]).toMatch(/a\.ts$/);
    expect(lines[1]).toMatch(/b\.ts$/);
  });

  it("count mode via rg", async () => {
    writeFileSync(join(dir, "a.ts"), "x\nx\ny");
    const out = await rgHandler({ pattern: "x", path: dir, output_mode: "count" }, ctx) as string;
    // ripgrep --count prints `<path>:<n>` per file with matches
    expect(out).toMatch(/a\.ts:2/);
  });

  it("max_results caps total content lines via rg", async () => {
    writeFileSync(join(dir, "a.ts"), Array.from({ length: 500 }, (_, i) => `match-${i}`).join("\n"));
    const out = await rgHandler({ pattern: "match", path: dir, max_results: 10 }, ctx) as string;
    const lines = out.split("\n").filter(Boolean);
    expect(lines.length).toBeLessThanOrEqual(11); // 10 results + optional truncation marker
  });

  it("respects ctx.signal abort", async () => {
    writeFileSync(join(dir, "big.txt"), Array.from({ length: 100000 }, (_, i) => `line-${i}-match`).join("\n"));
    const ac = new AbortController();
    const aborted = { signal: ac.signal, callId: "c1", log: () => {} } as any;
    const p = rgHandler({ pattern: "match", path: dir }, aborted);
    setTimeout(() => ac.abort(), 5);
    const out = await p;
    // Whether or not output arrived before kill, we should not throw.
    expect(typeof out).toBe("string");
  });
});
