import { describe, it, expect } from "bun:test";
import { parseFrontmatter } from "../frontmatter.ts";

describe("parseFrontmatter", () => {
  it("parses minimal valid frontmatter", () => {
    const r = parseFrontmatter("---\nname: foo\ndescription: bar\n---\nbody here\n");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.name).toBe("foo");
    expect(r.manifest.description).toBe("bar");
    expect(r.manifest.tokens).toBeUndefined();
    expect(r.body).toBe("body here\n");
  });

  it("parses tokens override as integer", () => {
    const r = parseFrontmatter("---\nname: foo\ndescription: bar\ntokens: 999\n---\nx");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.tokens).toBe(999);
  });

  it("strips quoted values", () => {
    const r = parseFrontmatter('---\nname: "foo"\ndescription: "with: colon"\n---\nx');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.name).toBe("foo");
    expect(r.manifest.description).toBe("with: colon");
  });

  it("rejects when frontmatter delimiter missing", () => {
    const r = parseFrontmatter("# just a heading\nbody");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/frontmatter/i);
  });

  it("rejects when closing delimiter missing", () => {
    const r = parseFrontmatter("---\nname: foo\nbody without close");
    expect(r.ok).toBe(false);
  });

  it("rejects when name missing", () => {
    const r = parseFrontmatter("---\ndescription: bar\n---\nx");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/name/);
  });

  it("rejects when description missing", () => {
    const r = parseFrontmatter("---\nname: foo\n---\nx");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/description/);
  });

  it("rejects non-integer tokens", () => {
    const r = parseFrontmatter("---\nname: foo\ndescription: bar\ntokens: abc\n---\nx");
    expect(r.ok).toBe(false);
  });

  it("ignores unknown keys (forward-compat)", () => {
    const r = parseFrontmatter("---\nname: foo\ndescription: bar\nfuture: yes\n---\nx");
    expect(r.ok).toBe(true);
  });

  it("preserves body verbatim including frontmatter-looking lines later", () => {
    const txt = "---\nname: foo\ndescription: bar\n---\nstep 1: do the thing\n---\nfooter";
    const r = parseFrontmatter(txt);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body).toBe("step 1: do the thing\n---\nfooter");
  });
});
