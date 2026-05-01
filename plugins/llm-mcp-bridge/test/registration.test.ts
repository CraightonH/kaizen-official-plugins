import { describe, it, expect } from "bun:test";
import { toToolRegistration, makeReadMcpResourceTool, makeListMcpResourcesTool } from "../registration.ts";
import { makeMockClient } from "./mockServer.ts";

const dummyCtx = { signal: new AbortController().signal, callId: "c1", log: () => {} };

describe("toToolRegistration", () => {
  it("namespaces tool name and tags", () => {
    const c = makeMockClient();
    const reg = toToolRegistration("github", {
      name: "search_code",
      description: "Search GitHub code.",
      inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
    }, () => c, 30000);
    expect(reg.schema.name).toBe("mcp:github:search_code");
    expect(reg.schema.description).toBe("Search GitHub code.");
    expect(reg.schema.tags).toEqual(["mcp", "mcp:github"]);
    expect(reg.schema.parameters).toEqual({ type: "object", properties: { q: { type: "string" } }, required: ["q"] });
  });

  it("falls back to a permissive schema when inputSchema is missing", () => {
    const c = makeMockClient();
    const reg = toToolRegistration("x", { name: "t", description: "" }, () => c, 30000);
    expect(reg.schema.parameters).toEqual({ type: "object", properties: {} });
  });

  it("handler proxies callTool and flattens text content", async () => {
    const c = makeMockClient({
      toolHandler: async (n, args) => ({ content: [{ type: "text", text: "hello" }] }),
    });
    const reg = toToolRegistration("srv", { name: "do", description: "" }, () => c, 30000);
    const out = await reg.handler({ x: 1 }, dummyCtx);
    expect(out).toBe("hello");
    expect(c.callsCallTool[0].args).toEqual({ x: 1 });
  });

  it("handler preserves multi-block text content as joined string", async () => {
    const c = makeMockClient({
      toolHandler: async () => ({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }),
    });
    const reg = toToolRegistration("s", { name: "t", description: "" }, () => c, 30000);
    expect(await reg.handler({}, dummyCtx)).toBe("a\nb");
  });

  it("handler returns structured JSON for non-text content blocks", async () => {
    const c = makeMockClient({
      toolHandler: async () => ({ content: [{ type: "image", data: "b64", mimeType: "image/png" }] }),
    });
    const reg = toToolRegistration("s", { name: "t", description: "" }, () => c, 30000);
    const out = await reg.handler({}, dummyCtx) as any;
    expect(Array.isArray(out)).toBe(true);
    expect(out[0].type).toBe("image");
  });

  it("handler throws mapped error on MCP failure", async () => {
    const c = makeMockClient({
      toolHandler: async () => { throw new Error("boom"); },
    });
    const reg = toToolRegistration("srv", { name: "t", description: "" }, () => c, 30000);
    await expect(reg.handler({}, dummyCtx)).rejects.toThrow(/mcp:srv:t failed: boom/);
  });

  it("handler fast-fails when getClient returns undefined (quarantined)", async () => {
    const reg = toToolRegistration("srv", { name: "t", description: "" }, () => undefined, 30000);
    await expect(reg.handler({}, dummyCtx)).rejects.toThrow(/mcp_server_unavailable/);
  });

  it("handler times out after timeoutMs", async () => {
    const c = makeMockClient({
      toolHandler: () => new Promise((r) => setTimeout(() => r({ content: [{ type: "text", text: "x" }] }), 200)),
    });
    const reg = toToolRegistration("srv", { name: "t", description: "" }, () => c, 50);
    await expect(reg.handler({}, dummyCtx)).rejects.toThrow(/timed out after 50ms/);
  });

  it("handler honors abort signal", async () => {
    const c = makeMockClient({
      toolHandler: () => new Promise((r) => setTimeout(() => r({ content: [{ type: "text", text: "x" }] }), 500)),
    });
    const ac = new AbortController();
    const reg = toToolRegistration("srv", { name: "t", description: "" }, () => c, 60000);
    const p = reg.handler({}, { ...dummyCtx, signal: ac.signal });
    setTimeout(() => ac.abort(), 10);
    await expect(p).rejects.toThrow(/aborted|cancel/i);
  });
});

describe("read_mcp_resource", () => {
  it("schema name + parameters", () => {
    const reg = makeReadMcpResourceTool(() => undefined);
    expect(reg.schema.name).toBe("read_mcp_resource");
    expect(reg.schema.parameters).toEqual({
      type: "object",
      properties: {
        server: { type: "string", description: "The configured MCP server name." },
        uri: { type: "string", description: "The MCP resource URI to read." },
      },
      required: ["server", "uri"],
    });
  });

  it("handler proxies readResource for the named server", async () => {
    const c = makeMockClient({
      resourceHandler: async (uri) => ({ contents: [{ uri, mimeType: "text/plain", text: "hi" }] }),
    });
    const reg = makeReadMcpResourceTool((name) => name === "fs" ? c : undefined);
    const out = await reg.handler({ server: "fs", uri: "file:///tmp/x" }, dummyCtx) as any;
    expect(out.contents[0].text).toBe("hi");
  });

  it("handler errors on unknown server", async () => {
    const reg = makeReadMcpResourceTool(() => undefined);
    await expect(reg.handler({ server: "missing", uri: "x" }, dummyCtx)).rejects.toThrow(/unknown MCP server: missing/);
  });

  it("handler errors on missing args", async () => {
    const reg = makeReadMcpResourceTool(() => undefined);
    await expect(reg.handler({}, dummyCtx)).rejects.toThrow(/server.*required/i);
  });
});

describe("list_mcp_resources", () => {
  it("aggregates across all healthy servers when server arg omitted", async () => {
    const a = makeMockClient({ resources: [{ uri: "file:///a" }] });
    const b = makeMockClient({ resources: [{ uri: "file:///b" }] });
    const reg = makeListMcpResourcesTool(() => [
      { name: "a", client: a },
      { name: "b", client: b },
    ]);
    const out = await reg.handler({}, dummyCtx) as any[];
    expect(out.map((r) => r.uri).sort()).toEqual(["file:///a", "file:///b"]);
    expect(out.find((r) => r.uri === "file:///a").server).toBe("a");
  });

  it("filters to one server when server arg present", async () => {
    const a = makeMockClient({ resources: [{ uri: "file:///a" }] });
    const b = makeMockClient({ resources: [{ uri: "file:///b" }] });
    const reg = makeListMcpResourcesTool(() => [
      { name: "a", client: a },
      { name: "b", client: b },
    ]);
    const out = await reg.handler({ server: "b" }, dummyCtx) as any[];
    expect(out.map((r) => r.uri)).toEqual(["file:///b"]);
  });
});
