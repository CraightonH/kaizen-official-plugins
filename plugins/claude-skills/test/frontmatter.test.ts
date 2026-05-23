import { describe, it, expect } from "bun:test";
import { parseFrontmatter } from "../frontmatter.ts";

describe("parseFrontmatter", () => {
  it("parses a minimal valid skill", () => {
    const text = "---\nname: foo\ndescription: A foo skill\n---\nBODY";
    const r = parseFrontmatter(text);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manifest.name).toBe("foo");
      expect(r.manifest.description).toBe("A foo skill");
      expect(r.body).toBe("BODY");
    }
  });

  it("strips balanced quotes from values", () => {
    const text = `---\nname: "foo"\ndescription: 'A foo skill'\n---\nBODY`;
    const r = parseFrontmatter(text);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manifest.name).toBe("foo");
      expect(r.manifest.description).toBe("A foo skill");
    }
  });

  it("honors an explicit tokens override", () => {
    const text = "---\nname: foo\ndescription: d\ntokens: 1234\n---\nBODY";
    const r = parseFrontmatter(text);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.manifest.tokens).toBe(1234);
  });

  it("silently ignores unknown keys (allowed-tools, etc.)", () => {
    const text = "---\nname: foo\ndescription: d\nallowed-tools: [Bash, Read]\ncolor: red\n---\nBODY";
    const r = parseFrontmatter(text);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manifest.name).toBe("foo");
      expect(r.manifest.description).toBe("d");
    }
  });

  it("rejects missing name", () => {
    const text = "---\ndescription: d\n---\nBODY";
    const r = parseFrontmatter(text);
    expect(r.ok).toBe(false);
  });

  it("rejects missing description", () => {
    const text = "---\nname: foo\n---\nBODY";
    const r = parseFrontmatter(text);
    expect(r.ok).toBe(false);
  });

  it("rejects an unclosed frontmatter block", () => {
    const text = "---\nname: foo\ndescription: d\nBODY";
    const r = parseFrontmatter(text);
    expect(r.ok).toBe(false);
  });

  it("rejects a body with no frontmatter", () => {
    const text = "BODY only, no frontmatter";
    const r = parseFrontmatter(text);
    expect(r.ok).toBe(false);
  });

  it("ignores a leading BOM and trailing whitespace", () => {
    const text = "﻿---\nname: foo\ndescription: d\n---\nBODY  \n";
    const r = parseFrontmatter(text);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.body.trimEnd()).toBe("BODY");
  });
});
