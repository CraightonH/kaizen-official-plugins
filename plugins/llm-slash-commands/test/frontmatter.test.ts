import { describe, it, expect } from "bun:test";
import { parseMarkdownCommandFile } from "../frontmatter.ts";

const VALID = `---
description: Echoes its argument.
usage: "<text>"
arguments:
  required: true
---
You said: {{args}}.
`;

describe("parseMarkdownCommandFile", () => {
  it("parses valid frontmatter + body", () => {
    const r = parseMarkdownCommandFile("/p/echo.md", VALID);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.description).toBe("Echoes its argument.");
    expect(r.usage).toBe("<text>");
    expect(r.argumentsRequired).toBe(true);
    expect(r.body).toBe("You said: {{args}}.\n");
  });

  it("treats missing frontmatter as error", () => {
    const r = parseMarkdownCommandFile("/p/no-fm.md", "Just a body.\n");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/frontmatter/i);
  });

  it("treats malformed YAML as error", () => {
    const raw = "---\ndescription: [unterminated\n---\nbody\n";
    const r = parseMarkdownCommandFile("/p/bad.md", raw);
    expect(r.ok).toBe(false);
  });

  it("missing description is an error", () => {
    const raw = "---\nusage: foo\n---\nbody\n";
    const r = parseMarkdownCommandFile("/p/x.md", raw);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/description/i);
  });

  it("argumentsRequired defaults to false when frontmatter omits it", () => {
    const raw = "---\ndescription: ok\n---\nbody\n";
    const r = parseMarkdownCommandFile("/p/x.md", raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.argumentsRequired).toBe(false);
  });

  it("preserves body whitespace and {{args}} occurrences", () => {
    const raw = "---\ndescription: d\n---\n{{args}} and {{args}} again\n";
    const r = parseMarkdownCommandFile("/p/x.md", raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body).toBe("{{args}} and {{args}} again\n");
  });
});
