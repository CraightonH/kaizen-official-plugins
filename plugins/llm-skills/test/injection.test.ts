import { describe, it, expect } from "bun:test";
import { buildSkillsBlock } from "../injection.ts";

const TWO = [
  { name: "git-rebase", description: "How to do a clean interactive rebase without losing work.", tokens: 420 },
  { name: "python/poetry-deps", description: "Adding, upgrading, and locking Poetry dependencies.", tokens: 180 },
];

describe("buildSkillsBlock", () => {
  it("returns empty string when list is empty", () => {
    expect(buildSkillsBlock([])).toBe("");
  });

  it("renders preamble + bullets without a ## heading", () => {
    const s = buildSkillsBlock(TWO);
    // Must NOT include the heading (provided by section title instead).
    expect(s.includes("## Available skills")).toBe(false);
    // Must include the preamble and bullets.
    expect(s).toContain("Call the `load_skill` tool");
    expect(s).toContain("- git-rebase (~420 tokens): How to do a clean interactive rebase without losing work.");
    expect(s).toContain("- python/poetry-deps (~180 tokens): Adding, upgrading, and locking Poetry dependencies.");
  });

  it("starts with the preamble (no leading blank line)", () => {
    const s = buildSkillsBlock(TWO);
    expect(s.startsWith("The following skills")).toBe(true);
  });

  it("collapses newlines in descriptions to spaces", () => {
    const s = buildSkillsBlock([{ name: "x", description: "line1\nline2", tokens: 1 }]);
    expect(s).toContain("- x (~1 tokens): line1 line2");
    expect(s.includes("line1\nline2")).toBe(false);
  });

  it("uses ~0 tokens when manifest tokens is undefined", () => {
    const s = buildSkillsBlock([{ name: "x", description: "d" } as any]);
    expect(s).toContain("(~0 tokens)");
  });
});
