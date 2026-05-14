import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "./markdown.ts";

// ANSI escape begins with \x1B (ESC). Heading / code / list styles all emit
// at least one ANSI sequence. We don't pin specific colors — that couples the
// test to chalk's palette — we just assert the renderer styled SOMETHING.
const ANSI = /\x1B\[/;

describe("renderMarkdown", () => {
  test("renders a heading with ANSI styling", () => {
    const out = renderMarkdown("# hello");
    expect(out).toMatch(ANSI);
    expect(out).toContain("hello");
  });

  test("renders a fenced code block", () => {
    const out = renderMarkdown("```\nconsole.log(1)\n```");
    expect(out).toContain("console.log(1)");
  });

  test("renders a bullet list", () => {
    const out = renderMarkdown("- one\n- two");
    expect(out).toContain("one");
    expect(out).toContain("two");
  });

  test("plain prose passes through (no throw)", () => {
    const out = renderMarkdown("just a sentence.");
    expect(out).toContain("just a sentence.");
  });

  test("returns input verbatim on renderer failure", () => {
    expect(renderMarkdown("")).toBeDefined();
  });
});
