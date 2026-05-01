import { describe, it, expect } from "bun:test";
import { loadConfig } from "../config.ts";
import { readFile } from "node:fs/promises";

function makeDeps(overrides: Partial<Parameters<typeof loadConfig>[0]> = {}) {
  const logs: string[] = [];
  return {
    home: "/home/u",
    cwd: "/proj",
    env: {} as Record<string, string | undefined>,
    readFile: async (p: string) => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
    log: (m: string) => logs.push(m),
    _logs: logs,
    ...overrides,
  };
}

describe("loadConfig", () => {
  it("returns empty map and logs info when no files exist", async () => {
    const deps = makeDeps();
    const result = await loadConfig(deps);
    expect(result.servers.size).toBe(0);
    expect(deps._logs.some((l) => l.includes("no MCP config"))).toBe(true);
  });

  it("loads user file when only ~/.kaizen/mcp/servers.json exists", async () => {
    const userJson = await readFile("plugins/llm-mcp-bridge/test/fixtures/servers.user.json", "utf8");
    const deps = makeDeps({
      readFile: async (p: string) => {
        if (p === "/home/u/.kaizen/mcp/servers.json") return userJson;
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
      env: { TEST_TOKEN: "tok123" },
    });
    const result = await loadConfig(deps);
    expect(result.servers.has("filesystem")).toBe(true);
    expect(result.servers.has("github")).toBe(true);
    expect(result.servers.get("github")!.headers!.Authorization).toBe("Bearer tok123");
    // Disabled server is in the map with status precursor "disabled"
    expect(result.servers.get("disabled-server")!.enabled).toBe(false);
  });

  it("project overrides user on conflict", async () => {
    const userJson = await readFile("plugins/llm-mcp-bridge/test/fixtures/servers.user.json", "utf8");
    const projJson = await readFile("plugins/llm-mcp-bridge/test/fixtures/servers.project.json", "utf8");
    const deps = makeDeps({
      readFile: async (p: string) => {
        if (p === "/home/u/.kaizen/mcp/servers.json") return userJson;
        if (p === "/proj/.kaizen/mcp/servers.json") return projJson;
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
      env: { TEST_TOKEN: "tok", INTERNAL_KEY: "k" },
    });
    const result = await loadConfig(deps);
    const fs = result.servers.get("filesystem")!;
    expect(fs.args).toEqual(["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/code"]);
    // user-only entries survive
    expect(result.servers.has("github")).toBe(true);
    // project-only entries are added
    expect(result.servers.has("internal-api")).toBe(true);
    expect(result.warnings.some((w) => w.includes("filesystem") && w.toLowerCase().includes("override"))).toBe(true);
  });

  it("KAIZEN_MCP_CONFIG env var overrides both", async () => {
    const userJson = await readFile("plugins/llm-mcp-bridge/test/fixtures/servers.user.json", "utf8");
    const deps = makeDeps({
      readFile: async (p: string) => {
        if (p === "/cfg/override.json") return userJson;
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
      env: { KAIZEN_MCP_CONFIG: "/cfg/override.json", TEST_TOKEN: "x" },
    });
    const result = await loadConfig(deps);
    expect(result.servers.has("filesystem")).toBe(true);
  });

  it("infers transport: command -> stdio, url -> http, explicit sse honored", async () => {
    const userJson = await readFile("plugins/llm-mcp-bridge/test/fixtures/servers.user.json", "utf8");
    const projJson = await readFile("plugins/llm-mcp-bridge/test/fixtures/servers.project.json", "utf8");
    const deps = makeDeps({
      readFile: async (p: string) => {
        if (p === "/home/u/.kaizen/mcp/servers.json") return userJson;
        if (p === "/proj/.kaizen/mcp/servers.json") return projJson;
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
      env: { TEST_TOKEN: "x", INTERNAL_KEY: "y" },
    });
    const result = await loadConfig(deps);
    expect(result.servers.get("filesystem")!.transport).toBe("stdio");
    expect(result.servers.get("github")!.transport).toBe("sse");
    expect(result.servers.get("internal-api")!.transport).toBe("http");
  });

  it("rejects invalid server names; keeps others", async () => {
    const deps = makeDeps({
      readFile: async (p: string) => {
        if (p === "/home/u/.kaizen/mcp/servers.json") {
          return JSON.stringify({
            servers: {
              "Bad Name!": { command: "true" },
              "ok-name": { command: "true" },
            },
          });
        }
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
    });
    const result = await loadConfig(deps);
    expect(result.servers.has("ok-name")).toBe(true);
    expect(result.servers.has("Bad Name!")).toBe(false);
    expect(result.warnings.some((w) => w.includes("Bad Name!"))).toBe(true);
  });

  it("missing env interpolation skips that server with warning", async () => {
    const deps = makeDeps({
      readFile: async (p: string) => {
        if (p === "/home/u/.kaizen/mcp/servers.json") {
          return JSON.stringify({
            servers: {
              "needs-env": {
                transport: "sse",
                url: "https://x",
                headers: { Authorization: "Bearer ${env:MISSING_VAR}" },
              },
              "fine": { command: "true" },
            },
          });
        }
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
    });
    const result = await loadConfig(deps);
    expect(result.servers.has("needs-env")).toBe(false);
    expect(result.servers.has("fine")).toBe(true);
    expect(result.warnings.some((w) => w.includes("MISSING_VAR"))).toBe(true);
  });

  it("malformed JSON in any source produces a warning, others continue", async () => {
    const deps = makeDeps({
      readFile: async (p: string) => {
        if (p === "/home/u/.kaizen/mcp/servers.json") return "not json{{";
        if (p === "/proj/.kaizen/mcp/servers.json") {
          return JSON.stringify({ servers: { "p": { command: "true" } } });
        }
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
    });
    const result = await loadConfig(deps);
    expect(result.servers.has("p")).toBe(true);
    expect(result.warnings.some((w) => w.toLowerCase().includes("malformed"))).toBe(true);
  });

  it("defaults: enabled=true, timeoutMs=30000, healthCheckMs=60000", async () => {
    const deps = makeDeps({
      readFile: async (p: string) => {
        if (p === "/home/u/.kaizen/mcp/servers.json") {
          return JSON.stringify({ servers: { "x": { command: "true" } } });
        }
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
    });
    const result = await loadConfig(deps);
    const x = result.servers.get("x")!;
    expect(x.enabled).toBe(true);
    expect(x.timeoutMs).toBe(30000);
    expect(x.healthCheckMs).toBe(60000);
  });
});
