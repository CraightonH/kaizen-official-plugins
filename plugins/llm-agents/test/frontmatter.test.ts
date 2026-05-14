import { describe, it, expect } from "bun:test";
import { parseAgentFile } from "../frontmatter.ts";

const VALID = `---
name: code-reviewer
description: >-
  Use when the user wants a focused review of a diff or specific file.
  Returns inline review comments grouped by file.
tools: ["read_file", "list_files", "grep*"]
tags: ["read-only"]
model: "gpt-4o-mini"
---
You are a code reviewer.
Be terse.
`;

describe("parseAgentFile", () => {
  it("parses a valid file", () => {
    const r = parseAgentFile(VALID);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.name).toBe("code-reviewer");
    expect(r.manifest.description).toContain("focused review");
    expect(r.manifest.toolFilter?.names).toEqual(["read_file", "list_files", "grep*"]);
    expect(r.manifest.toolFilter?.tags).toEqual(["read-only"]);
    expect(r.manifest.modelOverride).toBe("gpt-4o-mini");
    expect(r.manifest.systemPrompt).toBe("You are a code reviewer.\nBe terse.\n");
  });

  it("rejects body-only file (no frontmatter)", () => {
    const r = parseAgentFile("just a body\n");
    expect(r.ok).toBe(false);
  });

  it("rejects missing required name", () => {
    const text = `---\ndescription: "x"\n---\nbody\n`;
    const r = parseAgentFile(text);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/name/i);
  });

  it("rejects missing required description", () => {
    const text = `---\nname: a\n---\nbody\n`;
    const r = parseAgentFile(text);
    expect(r.ok).toBe(false);
  });

  it("rejects malformed YAML (unclosed array)", () => {
    const text = `---\nname: a\ndescription: "d"\ntools: [\n---\nbody\n`;
    const r = parseAgentFile(text);
    expect(r.ok).toBe(false);
  });

  it("rejects invalid name characters", () => {
    const text = `---\nname: "Bad Name!"\ndescription: "d"\n---\nbody\n`;
    const r = parseAgentFile(text);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/name/i);
  });

  it("ignores tools/tags/model when absent", () => {
    const text = `---\nname: a\ndescription: "d"\n---\nbody\n`;
    const r = parseAgentFile(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.toolFilter).toBeUndefined();
    expect(r.manifest.modelOverride).toBeUndefined();
  });
});

describe("disallowedTools / disallowedTags", () => {
  it("parses disallowedTools into toolFilter.excludeNames", () => {
    const text = `---
name: a
description: An agent.
disallowedTools: ["edit_file", "write_file"]
---
body`;
    const r = parseAgentFile(text);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.manifest.toolFilter?.excludeNames).toEqual(["edit_file", "write_file"]);
  });

  it("parses disallowedTags into toolFilter.excludeTags", () => {
    const text = `---
name: a
description: An agent.
disallowedTags: ["destructive", "network"]
---
body`;
    const r = parseAgentFile(text);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.manifest.toolFilter?.excludeTags).toEqual(["destructive", "network"]);
  });

  it("merges all four filter halves when present", () => {
    const text = `---
name: a
description: An agent.
tools: ["read_file"]
tags: ["read-only"]
disallowedTools: ["edit_file"]
disallowedTags: ["destructive"]
---
body`;
    const r = parseAgentFile(text);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.manifest.toolFilter).toEqual({
      names: ["read_file"],
      tags: ["read-only"],
      excludeNames: ["edit_file"],
      excludeTags: ["destructive"],
    });
  });

  it("rejects malformed disallowedTools (non-array)", () => {
    const text = `---
name: a
description: An agent.
disallowedTools: "edit_file"
---
body`;
    const r = parseAgentFile(text);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error).toBe("'disallowedTools' must be an array of strings");
  });

  it("rejects malformed disallowedTags (non-string element)", () => {
    const text = `---
name: a
description: An agent.
disallowedTags: ["ok", 42]
---
body`;
    const r = parseAgentFile(text);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error).toMatch(/disallowedTags|array items must be strings/);
  });

  it("treats absent disallowed fields as no denylist (no excludeNames/excludeTags in toolFilter)", () => {
    const text = `---
name: a
description: An agent.
tools: ["read_file"]
---
body`;
    const r = parseAgentFile(text);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.manifest.toolFilter).toEqual({ names: ["read_file"], tags: undefined });
  });
});
