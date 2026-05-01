import { describe, it, expect, mock } from "bun:test";
import { createRegistry } from "../registry.ts";
import { registerBuiltins } from "../builtins.ts";
import { loadFileCommands, type FileLoaderDeps } from "../file-loader.ts";

function makeFsDeps(files: Record<string, string>): Pick<FileLoaderDeps, "readDir" | "readFile"> {
  return {
    readDir: async (dir: string) => {
      const prefix = dir.endsWith("/") ? dir : dir + "/";
      return Object.keys(files)
        .filter(p => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"))
        .map(p => p.slice(prefix.length));
    },
    readFile: async (path: string) => {
      if (!(path in files)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return files[path]!;
    },
  };
}

const VALID = `---
description: Echo your input.
---
You said: {{args}}.
`;

describe("loadFileCommands", () => {
  it("registers a file command from user dir", async () => {
    const reg = createRegistry();
    const fs = makeFsDeps({ "/u/.kaizen/commands/echo.md": VALID });
    const warnings = await loadFileCommands({
      home: "/u", cwd: "/p", registry: reg, ...fs, getDriver: () => undefined,
    });
    expect(warnings).toEqual([]);
    const m = reg.get("echo")!.manifest;
    expect(m.source).toBe("file");
    expect(m.filePath).toBe("/u/.kaizen/commands/echo.md");
  });

  it("project shadows user (project wins) with debug warning suppressed but DuplicateRegistrationError surfaced", async () => {
    const reg = createRegistry();
    // user first, then project — but our loader always loads user first; if both exist with same name,
    // project must replace user. Loader needs to unregister the user entry before registering project.
    const fs = makeFsDeps({
      "/u/.kaizen/commands/echo.md": VALID,
      "/p/.kaizen/commands/echo.md": VALID.replace("Echo your input.", "Project echo."),
    });
    const warnings = await loadFileCommands({
      home: "/u", cwd: "/p", registry: reg, ...fs, getDriver: () => undefined,
    });
    expect(warnings).toEqual([]);
    expect(reg.get("echo")!.manifest.description).toBe("Project echo.");
    expect(reg.get("echo")!.manifest.filePath).toBe("/p/.kaizen/commands/echo.md");
  });

  it("rejects a file colliding with a built-in (e.g. help.md) with a clear warning", async () => {
    const reg = createRegistry();
    registerBuiltins(reg);
    const fs = makeFsDeps({ "/u/.kaizen/commands/help.md": VALID });
    const warnings = await loadFileCommands({
      home: "/u", cwd: "/p", registry: reg, ...fs, getDriver: () => undefined,
    });
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/help\.md/);
    expect(warnings[0]).toMatch(/reserved/i);
    expect(reg.get("help")!.manifest.source).toBe("builtin");
  });

  it("malformed frontmatter → file skipped with warning, no crash", async () => {
    const reg = createRegistry();
    const fs = makeFsDeps({ "/u/.kaizen/commands/bad.md": "no frontmatter here\n" });
    const warnings = await loadFileCommands({
      home: "/u", cwd: "/p", registry: reg, ...fs, getDriver: () => undefined,
    });
    expect(reg.get("bad")).toBeUndefined();
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/bad\.md/);
  });

  it("invokes handler: substitutes {{args}}, emits conversation:user-message, calls runConversation", async () => {
    const reg = createRegistry();
    const fs = makeFsDeps({ "/u/.kaizen/commands/echo.md": VALID });
    const emit = mock(async (_e: string, _p: unknown) => {});
    const runConversation = mock(async () => ({ finalMessage: { role: "assistant", content: "" }, messages: [], usage: { promptTokens: 0, completionTokens: 0 } }));
    const driver = { runConversation };
    await loadFileCommands({
      home: "/u", cwd: "/p", registry: reg, ...fs, getDriver: () => driver as any,
    });
    const ctx: any = { args: "hello world", raw: "/echo hello world", signal: new AbortController().signal, emit, print: async () => {} };
    await reg.get("echo")!.handler(ctx);
    const userMsgCalls = emit.mock.calls.filter((c) => c[0] === "conversation:user-message");
    expect(userMsgCalls.length).toBe(1);
    const payload: any = userMsgCalls[0]![1];
    expect(payload.message.role).toBe("user");
    expect(payload.message.content).toBe("You said: hello world.\n");
    expect(runConversation).toHaveBeenCalledTimes(1);
  });

  it("required-args validation: empty args prints usage and does NOT call runConversation", async () => {
    const reg = createRegistry();
    const fs = makeFsDeps({
      "/u/.kaizen/commands/needy.md": `---\ndescription: needs args\nusage: "<text>"\narguments:\n  required: true\n---\nyou: {{args}}\n`,
    });
    const runConversation = mock(async () => ({} as any));
    await loadFileCommands({
      home: "/u", cwd: "/p", registry: reg, ...fs, getDriver: () => ({ runConversation } as any),
    });
    const printed: string[] = [];
    const emit = mock(async () => {});
    const ctx: any = { args: "", raw: "/needy", signal: new AbortController().signal, emit, print: async (t: string) => { printed.push(t); } };
    await reg.get("needy")!.handler(ctx);
    expect(runConversation).not.toHaveBeenCalled();
    expect(printed.join("\n")).toMatch(/requires arguments/);
    expect(printed.join("\n")).toMatch(/<text>/);
  });

  it("missing dirs are tolerated", async () => {
    const reg = createRegistry();
    const fs: Pick<FileLoaderDeps, "readDir" | "readFile"> = {
      readDir: async () => { const e: any = new Error("ENOENT"); e.code = "ENOENT"; throw e; },
      readFile: async () => { throw new Error("unreachable"); },
    };
    const warnings = await loadFileCommands({
      home: "/u", cwd: "/p", registry: reg, ...fs, getDriver: () => undefined,
    });
    expect(warnings).toEqual([]);
  });
});
