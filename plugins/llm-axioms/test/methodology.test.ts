import { describe, it, expect } from "bun:test";
import { renderMethodology, METHODOLOGY_TEXT } from "../methodology.ts";

describe("renderMethodology", () => {
  it("returns a non-empty string with the canonical heading", () => {
    const out = renderMethodology();
    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain("# First-principles reasoning");
  });
  it("returns the same string instance across calls (cache identity)", () => {
    const a = renderMethodology();
    const b = renderMethodology();
    expect(a === b).toBe(true);
  });
  it("mentions the three tool names", () => {
    const out = renderMethodology();
    expect(out).toContain("axiom_record");
    expect(out).toContain("axiom_amend");
    expect(out).toContain("axiom_drop");
  });
  it("teaches the four-part axiom structure", () => {
    const out = renderMethodology();
    expect(out).toMatch(/statement/i);
    expect(out).toMatch(/premises/i);
    expect(out).toMatch(/reasoning/i);
    expect(out).toMatch(/scope/i);
  });
  it("exposes the constant directly", () => {
    expect(METHODOLOGY_TEXT).toBe(renderMethodology());
  });
});
