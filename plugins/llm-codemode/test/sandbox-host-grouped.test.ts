import { describe, expect, it } from "bun:test";
import { buildKaizenGlobal } from "../sandbox-host.ts";
import type { ToolRegistration } from "llm-tools-registry/public";

function reg(name: string, source: ToolRegistration["source"]): ToolRegistration {
  return {
    schema: { name, description: "", parameters: { type: "object", properties: {} } as any },
    handler: async () => null,
    source,
  };
}

describe("buildKaizenGlobal — grouped namespaces", () => {
  it("local tools are reachable via kaizen.tools.<name>", async () => {
    const invoked: string[] = [];
    const invoke = async (name: string) => { invoked.push(name); return "ok"; };
    const k = buildKaizenGlobal({
      registrations: [reg("readFile", { kind: "local" })],
      invoke,
    });
    const out = await (k.tools as any).readFile({});
    expect(out).toBe("ok");
    expect(invoked).toEqual(["readFile"]);
  });

  it("MCP tools are reachable via kaizen.mcp.<server>.<name>", async () => {
    const invoked: string[] = [];
    const invoke = async (name: string) => { invoked.push(name); return "ok"; };
    const k = buildKaizenGlobal({
      registrations: [reg("read_file", { kind: "mcp", server: "filesystem" })],
      invoke,
    });
    const out = await (k.mcp as any).filesystem.read_file({});
    expect(out).toBe("ok");
    expect(invoked).toEqual(["read_file"]);
  });

  it("MCP server name normalization applied: cloudflare-fs → cloudflare_fs", async () => {
    const k = buildKaizenGlobal({
      registrations: [reg("ping", { kind: "mcp", server: "cloudflare-fs" })],
      invoke: async () => "ok",
    });
    expect((k.mcp as any).cloudflare_fs).toBeDefined();
    expect((k.mcp as any)["cloudflare-fs"]).toBeUndefined();
  });

  it("empty namespaces are not exposed (no kaizen.agents when there are no agents)", () => {
    const k = buildKaizenGlobal({
      registrations: [reg("a", { kind: "local" })],
      invoke: async () => null,
    });
    expect((k as any).agents).toBeUndefined();
  });
});
