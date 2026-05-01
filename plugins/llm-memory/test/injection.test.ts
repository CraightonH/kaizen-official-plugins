import { describe, it, expect } from "bun:test";
import { buildMemoryBlock } from "../injection.ts";
import type { MemoryEntry } from "../public.d.ts";

const e = (name: string, description: string, scope: "project" | "global"): MemoryEntry => ({
  name, description, type: "reference", scope, body: "",
});

describe("buildMemoryBlock", () => {
  it("returns null when both layers empty", () => {
    expect(buildMemoryBlock({
      projectIndex: "", globalIndex: "", projectEntries: [], globalEntries: [], projectPath: "/p", byteCap: 2048,
    })).toBeNull();
  });
  it("emits project-only block when global empty", () => {
    const out = buildMemoryBlock({
      projectIndex: "# P\n", globalIndex: "", projectEntries: [e("a", "ad", "project")], globalEntries: [],
      projectPath: "/p", byteCap: 2048,
    });
    expect(out).not.toBeNull();
    expect(out!).toContain("<system-reminder>");
    expect(out!).toContain("# Persistent memory");
    expect(out!).toContain("## Project memory (/p)");
    expect(out!).toContain("# P");
    expect(out!).toContain("- project:a — ad");
    expect(out!).not.toContain("## Global memory");
  });
  it("emits both sections in correct order with both indexes set", () => {
    const out = buildMemoryBlock({
      projectIndex: "# P", globalIndex: "# G",
      projectEntries: [e("p1", "pd", "project")], globalEntries: [e("g1", "gd", "global")],
      projectPath: "/p", byteCap: 2048,
    })!;
    expect(out.indexOf("## Project memory")).toBeLessThan(out.indexOf("## Global memory"));
    expect(out).toContain("- project:p1 — pd");
    expect(out).toContain("- global:g1 — gd");
  });
  it("truncates the catalog (oldest first) when over cap", () => {
    const big = Array.from({ length: 50 }, (_, i) => e(`n${i}`, `desc-${i}`, "global"));
    const out = buildMemoryBlock({
      projectIndex: "", globalIndex: "", projectEntries: [], globalEntries: big,
      projectPath: "/p", byteCap: 256,
    })!;
    expect(out.length).toBeLessThanOrEqual(2 * 256 + 512); // generous wrapper allowance
    expect(out).toContain("[truncated]");
  });
  it("keeps body content but marks truncation when index alone exceeds cap", () => {
    const huge = "x".repeat(5000);
    const out = buildMemoryBlock({
      projectIndex: huge, globalIndex: "", projectEntries: [], globalEntries: [],
      projectPath: "/p", byteCap: 1024,
    })!;
    expect(out).toContain("[truncated]");
  });
});
