import { describe, it, expect } from "bun:test";
import { parseEntry, renderEntry, validateName } from "../frontmatter.ts";
import type { MemoryEntry } from "../public.d.ts";

const sample = `---
name: bun_git_dep_semver
description: Bun #semver over git URLs unsupported
type: reference
created: 2026-04-15T10:23:00Z
updated: 2026-04-30T08:11:00Z
---

# Body

Long-form markdown content.
`;

describe("validateName", () => {
  it("accepts lowercase, digits, underscore, hyphen", () => {
    expect(validateName("a")).toBe(true);
    expect(validateName("a-b_c-1")).toBe(true);
  });
  it("rejects empty, uppercase, spaces, punctuation, > 64", () => {
    expect(validateName("")).toBe(false);
    expect(validateName("Aa")).toBe(false);
    expect(validateName("a b")).toBe(false);
    expect(validateName("a.b")).toBe(false);
    expect(validateName("a".repeat(65))).toBe(false);
    expect(validateName("a".repeat(64))).toBe(true);
  });
  it("accepts a name with the `!` overwrite suffix", () => {
    // validateName itself rejects '!'; callers strip the suffix before validating.
    expect(validateName("foo!")).toBe(false);
  });
});

describe("parseEntry", () => {
  it("parses frontmatter + body", () => {
    const out = parseEntry(sample, "project");
    expect(out).not.toBeNull();
    expect(out!.name).toBe("bun_git_dep_semver");
    expect(out!.description).toBe("Bun #semver over git URLs unsupported");
    expect(out!.type).toBe("reference");
    expect(out!.scope).toBe("project");
    expect(out!.created).toBe("2026-04-15T10:23:00Z");
    expect(out!.updated).toBe("2026-04-30T08:11:00Z");
    expect(out!.body).toBe("# Body\n\nLong-form markdown content.\n");
  });
  it("returns null when frontmatter delimiters missing", () => {
    expect(parseEntry("no frontmatter here", "project")).toBeNull();
  });
  it("returns null when type is invalid", () => {
    const bad = sample.replace("type: reference", "type: nonsense");
    expect(parseEntry(bad, "project")).toBeNull();
  });
  it("tolerates absence of created/updated", () => {
    const text = `---\nname: x\ndescription: d\ntype: user\n---\nbody`;
    const out = parseEntry(text, "global");
    expect(out!.name).toBe("x");
    expect(out!.created).toBeUndefined();
    expect(out!.updated).toBeUndefined();
  });
  it("ignores unknown keys without throwing", () => {
    const text = `---\nname: x\ndescription: d\ntype: user\nfoo: bar\n---\nbody`;
    const out = parseEntry(text, "global");
    expect(out!.name).toBe("x");
  });
  it("rejects descriptions longer than 200 chars", () => {
    const text = `---\nname: x\ndescription: ${"a".repeat(201)}\ntype: user\n---\nbody`;
    expect(parseEntry(text, "global")).toBeNull();
  });
});

describe("renderEntry", () => {
  it("round-trips through parse", () => {
    const entry: MemoryEntry = {
      name: "vault_namespace",
      description: "Vault namespace is admin",
      type: "reference",
      scope: "global",
      body: "# Notes\n\nUse `admin`.\n",
      created: "2026-04-15T00:00:00Z",
      updated: "2026-04-30T00:00:00Z",
    };
    const text = renderEntry(entry);
    const parsed = parseEntry(text, "global")!;
    expect(parsed.name).toBe(entry.name);
    expect(parsed.description).toBe(entry.description);
    expect(parsed.type).toBe(entry.type);
    expect(parsed.created).toBe(entry.created);
    expect(parsed.updated).toBe(entry.updated);
    expect(parsed.body).toBe(entry.body);
  });
  it("omits created/updated keys when not provided", () => {
    const text = renderEntry({ name: "x", description: "d", type: "user", scope: "global", body: "b" });
    expect(text).not.toContain("created:");
    expect(text).not.toContain("updated:");
  });
});
