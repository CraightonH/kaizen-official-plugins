import { describe, it, expect } from "bun:test";
import { buildWorkspaceBlock } from "../injection.ts";
import type { AxiomEntry } from "../public.d.ts";

const a = (over: Partial<AxiomEntry>): AxiomEntry => ({
  id: "x",
  statement: "s",
  premises: ["p"],
  reasoning: "r",
  scope: "default",
  derivedAt: 1000,
  ...over,
});

describe("buildWorkspaceBlock", () => {
  it("returns null on empty input", () => {
    expect(buildWorkspaceBlock([], 4096)).toBeNull();
  });
  it("wraps output in <system-reminder>", () => {
    const out = buildWorkspaceBlock([a({ id: "one", statement: "S1" })], 4096)!;
    expect(out.startsWith("<system-reminder>")).toBe(true);
    expect(out.endsWith("</system-reminder>")).toBe(true);
  });
  it("groups by scope, listing axiom id + statement in each group", () => {
    const out = buildWorkspaceBlock(
      [
        a({ id: "u1", statement: "UX truth", scope: "UX" }),
        a({ id: "u2", statement: "Another UX truth", scope: "UX" }),
        a({ id: "a1", statement: "Auth truth", scope: "Auth" }),
      ],
      4096,
    )!;
    expect(out).toContain("## UX");
    expect(out).toContain("## Auth");
    expect(out).toContain("u1");
    expect(out).toContain("UX truth");
    expect(out).toContain("Another UX truth");
    expect(out).toContain("a1");
    expect(out).toContain("Auth truth");
  });
  it("includes premises and reasoning per axiom", () => {
    const out = buildWorkspaceBlock(
      [a({ id: "k", statement: "S", premises: ["alpha", "beta"], reasoning: "because" })],
      4096,
    )!;
    expect(out).toContain("alpha");
    expect(out).toContain("beta");
    expect(out).toContain("because");
  });
  it("truncates oldest-first when over byte cap and appends [truncated]", () => {
    const big = "X".repeat(200);
    const items = [
      a({ id: "old", statement: big, derivedAt: 1 }),
      a({ id: "new", statement: big, derivedAt: 2 }),
    ];
    const out = buildWorkspaceBlock(items, 220)!;
    expect(out).toContain("[truncated]");
    expect(out).toContain("new");
    // "old" might still appear in the truncation marker line, but not as a header
    expect(out.includes("### old")).toBe(false);
  });
});
