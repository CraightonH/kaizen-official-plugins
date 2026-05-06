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

  it("/exit emits harness:exit-requested exactly once with {}", async () => {
    const reg = createRegistry();
    registerBuiltins(reg);
    const { ctx, emitted } = makeCtx();
    await reg.get("exit")!.handler(ctx as any);
    expect(emitted).toEqual([{ event: "harness:exit-requested", payload: {} }]);
  });

  it("registers session commands when sessions store is supplied", async () => {
    const reg = createRegistry();
    const sessions = {
      next: 0,
      records: [] as any[],
      async create() {
        const record = { id: `s${++this.next}`, harness: "h", metadata: {}, createdAt: this.next, pluginFingerprint: [] };
        this.records.push(record);
        return record;
      },
      async list() { return this.records; },
      async exists(id: string) { return this.records.some((r) => r.id === id); },
      async load(id: string) { return this.records.find((r) => r.id === id); },
      async delete(id: string) { this.records = this.records.filter((r) => r.id !== id && !r.id.startsWith(id + "/")); },
    };
    let active: string | null = null;
    registerBuiltins(reg, { sessions: sessions as any, getActiveSessionId: () => active });
    expect(reg.get("session:new")).toBeDefined();
    expect(reg.get("session:list")).toBeDefined();
    expect(reg.get("session:resume")).toBeDefined();
    expect(reg.get("session:delete")).toBeDefined();
    expect(reg.get("clear")).toBeDefined();

    const { ctx, emitted, printed } = makeCtx();
    ctx.emit = mock(async (event: string, payload: any) => {
      emitted.push({ event, payload });
      if (event === "session:active-changed") active = payload.to;
    });
    await reg.get("session:new")!.handler(ctx as any);
    expect(active).toBe("s1");
    expect(emitted).toContainEqual({ event: "session:active-changed", payload: { from: null, to: "s1" } });
    await reg.get("session:list")!.handler(ctx as any);
    expect(printed.join("\n")).toContain("s1");
  });

  it("/clear archives by creating a new active session", async () => {
    const reg = createRegistry();
    const sessions = {
      async create() { return { id: "s-new", harness: "h", metadata: {}, createdAt: 1, pluginFingerprint: [] }; },
    };
    registerBuiltins(reg, { sessions: sessions as any, getActiveSessionId: () => "s-old" });
    const { ctx, emitted } = makeCtx();
    await reg.get("clear")!.handler(ctx as any);
    expect(emitted).toContainEqual({ event: "session:active-changed", payload: { from: "s-old", to: "s-new" } });
    expect(emitted).toContainEqual({ event: "conversation:cleared", payload: { from: "s-old", to: "s-new" } });
  });

  it("/session:delete active session creates replacement only after preflight", async () => {
    const reg = createRegistry();
    const deleted: any[] = [];
    const sessions = {
      records: [
        { id: "s1", harness: "h", metadata: {}, createdAt: 1, pluginFingerprint: [] },
        { id: "s1/child", harness: "h", parentSessionId: "s1", metadata: {}, createdAt: 2, pluginFingerprint: [] },
      ],
      async list() { return this.records; },
      async create() { return { id: "replacement", harness: "h", metadata: {}, createdAt: 3, pluginFingerprint: [] }; },
      async delete(id: string, opts: any) { deleted.push({ id, opts }); },
    };
    registerBuiltins(reg, { sessions: sessions as any, getActiveSessionId: () => "s1" });
    const { ctx, emitted } = makeCtx();
    ctx.args = "s1";
    await expect(reg.get("session:delete")!.handler(ctx as any)).rejects.toThrow(/children/);
    expect(deleted).toEqual([]);
    ctx.args = "s1 --cascade";
    await reg.get("session:delete")!.handler(ctx as any);
    expect(deleted).toEqual([{ id: "s1", opts: { cascade: true } }]);
    expect(emitted).toContainEqual({ event: "session:active-changed", payload: { from: "s1", to: "replacement" } });
  });

  it("/help with no args groups all registered commands", async () => {
    const reg = createRegistry();
    registerBuiltins(reg);
    // Simulate driver-coupled built-ins:
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
