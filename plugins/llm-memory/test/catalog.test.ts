import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderCatalog, mergeIntoIndex, regenerateIndex, CATALOG_START, CATALOG_END } from "../catalog.ts";
import type { MemoryEntry } from "../public.d.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "llm-memory-catalog-"));
}

const e = (name: string, description: string): MemoryEntry => ({
  name, description, type: "reference", scope: "global", body: "",
});

describe("renderCatalog", () => {
  it("emits empty markers for zero entries", () => {
    const out = renderCatalog([]);
    expect(out).toBe(`${CATALOG_START}\n${CATALOG_END}`);
  });
  it("emits sorted bullets between markers", () => {
    const out = renderCatalog([e("zeta", "z desc"), e("alpha", "a desc")]);
    expect(out).toBe(
      `${CATALOG_START}\n` +
      `- [alpha](alpha.md) — a desc\n` +
      `- [zeta](zeta.md) — z desc\n` +
      `${CATALOG_END}`,
    );
  });
});

describe("mergeIntoIndex", () => {
  it("appends markers when absent", () => {
    const out = mergeIntoIndex("# Title\n\nUser content.\n", renderCatalog([e("a", "d")]));
    expect(out).toContain("# Title");
    expect(out).toContain(CATALOG_START);
    expect(out).toContain("- [a](a.md) — d");
    expect(out.endsWith(`${CATALOG_END}\n`)).toBe(true);
  });
  it("preserves user content above markers byte-for-byte and replaces between markers", () => {
    const userPart = "# User\n\nNotes.\n\n";
    const prev = `${userPart}${CATALOG_START}\n- [old](old.md) — old\n${CATALOG_END}\n`;
    const out = mergeIntoIndex(prev, renderCatalog([e("new", "fresh")]));
    expect(out.startsWith(userPart)).toBe(true);
    expect(out).toContain("- [new](new.md) — fresh");
    expect(out).not.toContain("old.md");
  });
  it("treats empty prev as user content + appended markers", () => {
    const out = mergeIntoIndex("", renderCatalog([]));
    expect(out).toBe(`${CATALOG_START}\n${CATALOG_END}\n`);
  });
});

describe("regenerateIndex (filesystem)", () => {
  it("creates MEMORY.md when entries exist", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "a.md"), "---\nname: a\ndescription: d\ntype: user\n---\nbody");
    await regenerateIndex(dir);
    const text = readFileSync(join(dir, "MEMORY.md"), "utf8");
    expect(text).toContain("- [a](a.md) — d");
  });
  it("preserves above-marker user content across regenerations", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "MEMORY.md"), `# Mine\n\n${CATALOG_START}\n- [x](x.md) — old\n${CATALOG_END}\n`);
    writeFileSync(join(dir, "a.md"), "---\nname: a\ndescription: d\ntype: user\n---\nbody");
    await regenerateIndex(dir);
    const text = readFileSync(join(dir, "MEMORY.md"), "utf8");
    expect(text.startsWith("# Mine\n\n")).toBe(true);
    expect(text).toContain("- [a](a.md) — d");
  });
  it("temp file does not remain after regeneration", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "a.md"), "---\nname: a\ndescription: d\ntype: user\n---\nbody");
    await regenerateIndex(dir);
    const fs = await import("node:fs/promises");
    const ents = await fs.readdir(dir);
    expect(ents.some((x) => x.includes(".tmp."))).toBe(false);
  });
});
