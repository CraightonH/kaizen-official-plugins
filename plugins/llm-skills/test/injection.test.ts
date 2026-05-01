import { describe, it, expect } from "bun:test";
import { buildSkillsSection, applyInjection } from "../injection.ts";

const TWO = [
  { name: "git-rebase", description: "How to do a clean interactive rebase without losing work.", tokens: 420 },
  { name: "python/poetry-deps", description: "Adding, upgrading, and locking Poetry dependencies.", tokens: 180 },
];

describe("buildSkillsSection", () => {
  it("returns empty string when list is empty", () => {
    expect(buildSkillsSection([])).toBe("");
  });

  it("renders header + bullets with ~N tokens formatting", () => {
    const s = buildSkillsSection(TWO);
    expect(s.startsWith("## Available skills\n")).toBe(true);
    expect(s).toContain("- git-rebase (~420 tokens): How to do a clean interactive rebase without losing work.");
    expect(s).toContain("- python/poetry-deps (~180 tokens): Adding, upgrading, and locking Poetry dependencies.");
    expect(s).toContain("Call the `load_skill` tool");
  });

  it("collapses newlines in descriptions to spaces", () => {
    const s = buildSkillsSection([{ name: "x", description: "line1\nline2", tokens: 1 }]);
    expect(s).toContain("- x (~1 tokens): line1 line2");
    expect(s.includes("line1\nline2")).toBe(false);
  });

  it("uses ~0 tokens when manifest tokens is undefined", () => {
    const s = buildSkillsSection([{ name: "x", description: "d" } as any]);
    expect(s).toContain("(~0 tokens)");
  });
});

describe("applyInjection", () => {
  it("no-ops when list empty", () => {
    const req: any = { systemPrompt: "base" };
    applyInjection(req, []);
    expect(req.systemPrompt).toBe("base");
  });

  it("appends with leading blank line when systemPrompt non-empty", () => {
    const req: any = { systemPrompt: "base" };
    applyInjection(req, TWO);
    expect(req.systemPrompt.startsWith("base\n\n## Available skills\n")).toBe(true);
  });

  it("sets to section only when systemPrompt undefined", () => {
    const req: any = {};
    applyInjection(req, TWO);
    expect(req.systemPrompt.startsWith("## Available skills\n")).toBe(true);
  });

  it("treats empty string as undefined (no leading blank line)", () => {
    const req: any = { systemPrompt: "" };
    applyInjection(req, TWO);
    expect(req.systemPrompt.startsWith("## Available skills\n")).toBe(true);
  });
});
