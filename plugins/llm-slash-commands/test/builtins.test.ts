import { describe, it, expect, mock } from "bun:test";
import { createRegistry } from "../registry.ts";
import { registerBuiltins } from "../builtins.ts";

function makeCtx() {
  const printed: string[] = [];
  const emitted: { event: string; payload: unknown }[] = [];
  const ctx = {
    args: "",
    raw: "",
    signal: new AbortController().signal,
    emit: mock(async (event: string, payload: unknown) => { emitted.push({ event, payload }); }),
    print: mock(async (text: string) => { printed.push(text); }),
  };
  return { ctx, printed, emitted };
}

describe("registerBuiltins", () => {
  it("registers /help and /exit on the registry", () => {
    const reg = createRegistry();
    registerBuiltins(reg);
    expect(reg.get("help")).toBeDefined();
    expect(reg.get("exit")).toBeDefined();
    expect(reg.get("help")!.manifest.source).toBe("builtin");
  });

  it("/exit emits session:exit-requested exactly once with {}", async () => {
    const reg = createRegistry();
    registerBuiltins(reg);
    const { ctx, emitted } = makeCtx();
    await reg.get("exit")!.handler(ctx as any);
    expect(emitted).toEqual([{ event: "session:exit-requested", payload: {} }]);
  });

  it("/help with no args groups all registered commands", async () => {
    const reg = createRegistry();
    registerBuiltins(reg);
    // Simulate driver-coupled built-ins:
    reg.register({ name: "clear", description: "Clear conv", source: "builtin" }, async () => {});
    reg.register({ name: "model", description: "Pick model", source: "builtin", usage: "<id>" }, async () => {});
    // Simulate plugin namespaced:
    reg.register({ name: "mcp:reload", description: "Reload MCP", source: "plugin" }, async () => {});
    reg.register({ name: "skills:list", description: "List skills", source: "plugin" }, async () => {});
    // Simulate file-loaded:
    reg.register({ name: "echo", description: "Echo", source: "file", filePath: "/p/echo.md" }, async () => {});

    const { ctx, printed } = makeCtx();
    await reg.get("help")!.handler(ctx as any);
    const text = printed.join("\n");
    expect(text).toContain("Built-in");
    expect(text).toContain("/help");
    expect(text).toContain("/exit");
    expect(text).toContain("Driver");
    expect(text).toContain("/clear");
    expect(text).toContain("/model <id>");
    expect(text).toContain("MCP");
    expect(text).toContain("/mcp:reload");
    expect(text).toContain("Skills");
    expect(text).toContain("/skills:list");
    expect(text).toContain("User");
    expect(text).toContain("/echo");
    // Section ordering
    const order = ["Built-in", "Driver", "Skills", "MCP", "User"];
    let last = -1;
    for (const label of order) {
      const idx = text.indexOf(label);
      expect(idx).toBeGreaterThan(last);
      last = idx;
    }
  });

  it("/help <name> prints just that entry including filePath for file commands", async () => {
    const reg = createRegistry();
    registerBuiltins(reg);
    reg.register({ name: "echo", description: "Echo", source: "file", filePath: "/p/echo.md", usage: "[text]" }, async () => {});
    const { ctx, printed } = makeCtx();
    ctx.args = "echo";
    await reg.get("help")!.handler(ctx as any);
    const text = printed.join("\n");
    expect(text).toContain("/echo [text]");
    expect(text).toContain("Echo");
    expect(text).toContain("/p/echo.md");
  });

  it("/help <unknown> prints unknown-command line", async () => {
    const reg = createRegistry();
    registerBuiltins(reg);
    const { ctx, printed } = makeCtx();
    ctx.args = "nope";
    await reg.get("help")!.handler(ctx as any);
    expect(printed.join("\n")).toMatch(/Unknown command: \/nope/);
  });
});
