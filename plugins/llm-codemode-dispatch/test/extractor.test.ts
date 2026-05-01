import { describe, it, expect } from "bun:test";
import { extractCodeBlocks } from "../extractor.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const fx = (name: string) => readFileSync(join(import.meta.dir, "fixtures", name), "utf8");

describe("extractCodeBlocks", () => {
  it("returns empty when no code", () => {
    const r = extractCodeBlocks(fx("response-no-code.txt"), 8);
    expect(r.code).toBe("");
    expect(r.ignoredCount).toBe(0);
  });

  it("extracts one typescript block", () => {
    const r = extractCodeBlocks(fx("response-one-block.txt"), 8);
    expect(r.code).toContain("kaizen.tools.readFile");
    expect(r.ignoredCount).toBe(0);
  });

  it("concatenates multiple ts/typescript blocks with \\n;\\n", () => {
    const r = extractCodeBlocks(fx("response-multi-block.txt"), 8);
    expect(r.code).toContain("readFile");
    expect(r.code).toContain("JSON.parse");
    expect(r.code).toContain("\n;\n");
  });

  it("ignores non-ts languages", () => {
    const r = extractCodeBlocks(fx("response-mixed-langs.txt"), 8);
    expect(r.code).toBe("1 + 1;");
  });

  it("ignores blocks with no info string", () => {
    const r = extractCodeBlocks("```\nfoo\n```", 8);
    expect(r.code).toBe("");
  });

  it("recognizes ts, typescript, js, javascript (case-insensitive)", () => {
    expect(extractCodeBlocks("```TS\na;\n```", 8).code).toBe("a;");
    expect(extractCodeBlocks("```Javascript\nb;\n```", 8).code).toBe("b;");
  });

  it("respects backticks inside template literal via fence-length", () => {
    const r = extractCodeBlocks(fx("response-template-literal-backticks.txt"), 8);
    expect(r.code).toContain("inner");
    expect(r.code).toContain("not a fence");
  });

  it("malformed unterminated fence returns empty", () => {
    const r = extractCodeBlocks("```typescript\nno close", 8);
    expect(r.code).toBe("");
  });

  it("caps at maxBlocks and reports ignoredCount", () => {
    const blocks = Array(10).fill(0).map((_, i) => "```typescript\nconst _" + i + "=" + i + ";\n```").join("\n");
    const r = extractCodeBlocks(blocks, 3);
    expect(r.ignoredCount).toBe(7);
    expect(r.code.split("\n;\n").length).toBe(3);
  });

  it("handles CRLF line endings", () => {
    const src = "```typescript\r\n1+1;\r\n```\r\n";
    expect(extractCodeBlocks(src, 8).code).toBe("1+1;");
  });
});
