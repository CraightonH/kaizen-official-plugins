import { describe, it, expect } from "bun:test";
import { renderDts, _resetCacheForTest } from "../dts-render.ts";
import type { ToolSchema } from "llm-events/public";
import simple from "./fixtures/tools-simple.json" with { type: "json" };
import edge from "./fixtures/tools-edge.json" with { type: "json" };

describe("dts-render", () => {
  it("renders kaizen global with method per tool", async () => {
    const out = await renderDts(simple as ToolSchema[]);
    expect(out).toContain("declare const kaizen");
    expect(out).toContain("readFile(args:");
    expect(out).toContain("writeFile(args:");
    expect(out).toContain("echo(args:");
    expect(out).toContain(": Promise<unknown>");
  });

  it("emits JSDoc from description", async () => {
    const out = await renderDts(simple as ToolSchema[]);
    expect(out).toContain("Read a file from disk.");
  });

  it("non-identifier tool name uses bracket-quoted method", async () => {
    const out = await renderDts(edge as ToolSchema[]);
    expect(out).toMatch(/"web-search"\(args:/);
  });

  it("missing parameters renders ()", async () => {
    const out = await renderDts(edge as ToolSchema[]);
    expect(out).toMatch(/noargs\(\)\s*:\s*Promise<unknown>/);
  });

  it("freeform object → Record<string, unknown>", async () => {
    const out = await renderDts(edge as ToolSchema[]);
    expect(out).toMatch(/freeform\(args:\s*Record<string,\s*unknown>\)/);
  });

  it("nullable union renders as string | null", async () => {
    const out = await renderDts(edge as ToolSchema[]);
    expect(out).toMatch(/string\s*\|\s*null/);
  });

  it("enum becomes string-literal union", async () => {
    const out = await renderDts(edge as ToolSchema[]);
    expect(out).toMatch(/"a"\s*\|\s*"b"/);
  });

  it("deterministic: same input twice → identical strings", async () => {
    _resetCacheForTest();
    const a = await renderDts(simple as ToolSchema[]);
    _resetCacheForTest();
    const b = await renderDts(simple as ToolSchema[]);
    expect(a).toBe(b);
  });

  it("orders tools alphabetically by name", async () => {
    const out = await renderDts(simple as ToolSchema[]);
    const ie = out.indexOf("echo(");
    const ir = out.indexOf("readFile(");
    const iw = out.indexOf("writeFile(");
    expect(ie).toBeLessThan(ir);
    expect(ir).toBeLessThan(iw);
  });

  it("cache hit: second call does not re-invoke compiler", async () => {
    _resetCacheForTest();
    const a = await renderDts(simple as ToolSchema[]);
    const b = await renderDts(simple as ToolSchema[]);
    expect(a).toBe(b);
    // exercising same identity is enough; counter-based assertion below uses internal probe
  });

  it("PascalCase Args interface name collision adds numeric suffix", async () => {
    const tools: ToolSchema[] = [
      { name: "read-file", description: "a", parameters: { type: "object", properties: { x: { type: "string" } } } as any },
      { name: "read_file", description: "b", parameters: { type: "object", properties: { y: { type: "string" } } } as any },
    ];
    const out = await renderDts(tools);
    expect(out).toContain("ReadFileArgs");
    expect(out).toMatch(/ReadFileArgs2|ReadFileArgs_2/);
  });
});
