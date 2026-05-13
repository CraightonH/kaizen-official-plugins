import { describe, it, expect } from "bun:test";
import { makeRegistry } from "../registry.ts";
import { registerSlashCommands, type SlashRegistryLike } from "../slash.ts";
import type { ToolsRegistryService } from "llm-contracts/public";

interface RegisteredCommand {
  manifest: { name: string; description: string; usage?: string };
  handler: (ctx: { args: string; print: (t: string) => Promise<void> }) => Promise<void>;
}

function makeFakeSlash(): { svc: SlashRegistryLike; commands: RegisteredCommand[] } {
  const commands: RegisteredCommand[] = [];
  const svc: SlashRegistryLike = {
    register: (manifest, handler) => {
      commands.push({ manifest, handler });
      return () => {
        const i = commands.findIndex((c) => c.manifest.name === manifest.name);
        if (i >= 0) commands.splice(i, 1);
      };
    },
  };
  return { svc, commands };
}

function captureCtx() {
  const out: string[] = [];
  return {
    out,
    make: (args: string) => ({ args, print: async (t: string) => { out.push(t); } }),
  };
}

function seedRegistry(): ToolsRegistryService {
  const reg = makeRegistry(async () => []);
  reg.registerWith({
    schema: { name: "fs:read", description: "Read a file", parameters: { type: "object" } as any },
    handler: async () => null,
    source: { kind: "local" },
  });
  reg.registerWith({
    schema: { name: "mcp:github:search", description: "Search github", parameters: { type: "object" } as any, tags: ["mcp"] },
    handler: async () => null,
    source: { kind: "mcp", server: "github" },
  });
  reg.registerWith({
    schema: { name: "mcp:github:issue", description: "View issue", parameters: { type: "object" } as any },
    handler: async () => null,
    source: { kind: "mcp", server: "github" },
  });
  return reg;
}

describe("llm-tools-registry slash commands", () => {
  it("registers /tools:list and /tools:show", () => {
    const { svc, commands } = makeFakeSlash();
    registerSlashCommands(svc, makeRegistry(async () => []));
    expect(commands.map((c) => c.manifest.name).sort()).toEqual(["tools:list", "tools:show"]);
    for (const c of commands) {
      expect(c.manifest.description).toMatch(/\S/);
    }
  });

  it("/tools:list groups by source with local first", async () => {
    const { svc, commands } = makeFakeSlash();
    registerSlashCommands(svc, seedRegistry());
    const cap = captureCtx();
    const list = commands.find((c) => c.manifest.name === "tools:list")!;
    await list.handler(cap.make(""));
    const out = cap.out[0];
    expect(out).toContain("Tools (3 total)");
    expect(out).toContain("local (1)");
    expect(out).toContain("mcp:github (2)");
    expect(out).toContain("fs:read — Read a file");
    expect(out.indexOf("local")).toBeLessThan(out.indexOf("mcp:github"));
  });

  it("/tools:list reports empty registry", async () => {
    const { svc, commands } = makeFakeSlash();
    registerSlashCommands(svc, makeRegistry(async () => []));
    const cap = captureCtx();
    await commands.find((c) => c.manifest.name === "tools:list")!.handler(cap.make(""));
    expect(cap.out[0]).toBe("(no tools registered)");
  });

  it("/tools:show prints schema for a known tool", async () => {
    const { svc, commands } = makeFakeSlash();
    registerSlashCommands(svc, seedRegistry());
    const cap = captureCtx();
    await commands.find((c) => c.manifest.name === "tools:show")!.handler(cap.make("mcp:github:search"));
    const out = cap.out[0];
    expect(out).toContain("name:        mcp:github:search");
    expect(out).toContain("source:      mcp:github");
    expect(out).toContain("tags:        mcp");
    expect(out).toContain("parameters:");
  });

  it("/tools:show with no arg prints usage", async () => {
    const { svc, commands } = makeFakeSlash();
    registerSlashCommands(svc, seedRegistry());
    const cap = captureCtx();
    await commands.find((c) => c.manifest.name === "tools:show")!.handler(cap.make(""));
    expect(cap.out[0]).toBe("usage: /tools:show <name>");
  });

  it("/tools:show with unknown name reports error", async () => {
    const { svc, commands } = makeFakeSlash();
    registerSlashCommands(svc, seedRegistry());
    const cap = captureCtx();
    await commands.find((c) => c.manifest.name === "tools:show")!.handler(cap.make("nope"));
    expect(cap.out[0]).toBe("unknown tool: nope");
  });
});
