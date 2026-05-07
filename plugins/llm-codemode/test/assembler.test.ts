import { describe, expect, it } from "bun:test";
import { groupBySource, normalizeServerName, surfaceHash, renderSurface } from "../assembler.ts";
import type { ToolRegistration } from "llm-tools-registry/public";

function reg(name: string, source: ToolRegistration["source"], description = ""): ToolRegistration {
  return {
    schema: { name, description, parameters: { type: "object", properties: {} } as any },
    handler: async () => null,
    source,
  };
}

describe("normalizeServerName", () => {
  it("hyphens become underscores", () => {
    expect(normalizeServerName("cloudflare-fs")).toBe("cloudflare_fs");
  });
  it("dots become underscores", () => {
    expect(normalizeServerName("taxhawk.docs")).toBe("taxhawk_docs");
  });
  it("leading digit gets _ prefix", () => {
    expect(normalizeServerName("2024-stuff")).toBe("_2024_stuff");
  });
  it("preserves case", () => {
    expect(normalizeServerName("Filesystem")).toBe("Filesystem");
  });
});

describe("groupBySource", () => {
  it("partitions by source kind, with mcp sub-grouped by server", () => {
    const groups = groupBySource([
      reg("a", { kind: "local" }),
      reg("b", { kind: "mcp", server: "filesystem" }),
      reg("c", { kind: "mcp", server: "filesystem" }),
      reg("d", { kind: "mcp", server: "cloudflare-fs" }),
      reg("e", { kind: "agent" }),
    ]);
    expect(groups.local.map((r) => r.schema.name).sort()).toEqual(["a"]);
    expect(Object.keys(groups.mcp).sort()).toEqual(["cloudflare_fs", "filesystem"]);
    expect(groups.mcp.filesystem!.map((r) => r.schema.name).sort()).toEqual(["b", "c"]);
    expect(groups.agents.map((r) => r.schema.name)).toEqual(["e"]);
  });

  it("MCP server name collisions after normalization are reported", () => {
    const groups = groupBySource([
      reg("a", { kind: "mcp", server: "foo-bar" }),
      reg("b", { kind: "mcp", server: "foo.bar" }),
    ]);
    expect(groups.conflicts.length).toBe(1);
    expect(groups.conflicts[0]!.normalized).toBe("foo_bar");
  });
});

describe("surfaceHash", () => {
  it("identical input → identical hash", () => {
    const list = [reg("a", { kind: "local" }, "x")];
    expect(surfaceHash(list)).toBe(surfaceHash([...list]));
  });
  it("description change → different hash", () => {
    expect(surfaceHash([reg("a", { kind: "local" }, "x")])).not.toBe(
      surfaceHash([reg("a", { kind: "local" }, "y")]),
    );
  });
  it("ordering does not change hash (sorted internally)", () => {
    const a = reg("a", { kind: "local" });
    const b = reg("b", { kind: "local" });
    expect(surfaceHash([a, b])).toBe(surfaceHash([b, a]));
  });
});

describe("renderSurface", () => {
  it("emits only namespaces that have entries", async () => {
    const out = await renderSurface([reg("a", { kind: "local" })]);
    expect(out).toContain("kaizen.tools");
    expect(out).not.toContain("kaizen.mcp");
    expect(out).not.toContain("kaizen.agents");
  });
  it("groups MCP tools under kaizen.mcp.<normalized-server>", async () => {
    const out = await renderSurface([
      reg("read_file", { kind: "mcp", server: "filesystem" }),
      reg("read_file", { kind: "mcp", server: "cloudflare-fs" }),
    ]);
    expect(out).toContain("filesystem:");
    expect(out).toContain("cloudflare_fs:");
  });
  it("includes the preamble and a fenced typescript block", async () => {
    const out = await renderSurface([reg("a", { kind: "local" })]);
    expect(out).toContain("```typescript");
    expect(out).toMatch(/sandboxed TypeScript runtime/i);
  });
});
