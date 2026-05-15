import { test, expect, describe, it } from "bun:test";
import { makeToolRendererRegistry } from "./registry.ts";

test("register and lookup return the registered renderer", () => {
  const reg = makeToolRendererRegistry();
  const renderer = {
    toolName: "read_file",
    collapsedSummary: () => "summary",
    expandedView: () => null as any,
  };
  const off = reg.service.register(renderer);
  expect(reg.lookup("read_file")).toBe(renderer);
  off();
  expect(reg.lookup("read_file")).toBeUndefined();
});

test("unknown tool returns undefined", () => {
  const reg = makeToolRendererRegistry();
  expect(reg.lookup("nope")).toBeUndefined();
});

test("re-register replaces the prior renderer", () => {
  const reg = makeToolRendererRegistry();
  const r1 = { toolName: "x", collapsedSummary: () => "1", expandedView: () => null as any };
  const r2 = { toolName: "x", collapsedSummary: () => "2", expandedView: () => null as any };
  reg.service.register(r1);
  reg.service.register(r2);
  expect(reg.lookup("x")).toBe(r2);
});

describe("makeToolRendererRegistry — summarize", () => {
  it("uses registered renderer's collapsedSummary", () => {
    const reg = makeToolRendererRegistry();
    reg.service.register({
      toolName: "fs:read_file",
      collapsedSummary: (args: any) => `read ${args.path}`,
    });
    expect(reg.service.summarize("fs:read_file", { path: "/tmp/foo" })).toBe("read /tmp/foo");
  });

  it("falls back to name + JSON for unregistered tools", () => {
    const reg = makeToolRendererRegistry();
    const out = reg.service.summarize("mcp:github:list_issues", { state: "open" });
    expect(out).toContain("mcp:github:list_issues");
    expect(out).toContain(`"state": "open"`);
  });

  it("truncates long args with a suffix", () => {
    const reg = makeToolRendererRegistry();
    const big = "x".repeat(5000);
    const out = reg.service.summarize("noop", { big });
    expect(out.length).toBeLessThan(1700); // 1500 + name + suffix
    expect(out).toMatch(/… \(\d+ more chars\)/);
  });

  it("handles errors in collapsedSummary by falling back to JSON", () => {
    const reg = makeToolRendererRegistry();
    reg.service.register({
      toolName: "boom",
      collapsedSummary: () => { throw new Error("bad"); },
    });
    const out = reg.service.summarize("boom", { x: 1 });
    expect(out).toContain("boom");
    expect(out).toContain(`"x": 1`);
  });
});
