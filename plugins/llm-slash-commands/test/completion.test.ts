import { describe, it, expect } from "bun:test";
import { createRegistry } from "../registry.ts";
import { registerBuiltins } from "../builtins.ts";
import { buildCompletionSource } from "../completion.ts";

describe("buildCompletionSource", () => {
  it("returns id and trigger='/'", () => {
    const reg = createRegistry();
    const src = buildCompletionSource(reg);
    expect(src.trigger).toBe("/");
    expect(src.id).toBe("llm-slash-commands:registry");
  });

  it("filters by case-insensitive substring of name", async () => {
    const reg = createRegistry();
    registerBuiltins(reg);
    reg.register({ name: "mcp:reload", description: "r", source: "plugin" }, async () => {});
    const src = buildCompletionSource(reg);
    const items = await src.list("he");
    expect(items.map((i) => i.label)).toEqual(["/help"]);
  });

  it("matches substring anywhere in the name", async () => {
    const reg = createRegistry();
    reg.register({ name: "config:get", description: "g", source: "plugin" }, async () => {});
    reg.register({ name: "session:list", description: "l", source: "plugin" }, async () => {});
    const src = buildCompletionSource(reg);
    const items = await src.list("config");
    expect(items.map((i) => i.label)).toEqual(["/config:get"]);
  });

  it("case-folds the query", async () => {
    const reg = createRegistry();
    registerBuiltins(reg);
    const src = buildCompletionSource(reg);
    const items = await src.list("HELP");
    expect(items.map((i) => i.label)).toEqual(["/help"]);
  });

  it("returns all when query empty (user just typed '/')", async () => {
    const reg = createRegistry();
    registerBuiltins(reg);
    reg.register({ name: "mcp:reload", description: "r", source: "plugin" }, async () => {});
    const src = buildCompletionSource(reg);
    const items = await src.list("");
    // Three built-ins (exit, help, history) + one namespaced (mcp:reload).
    expect(items.length).toBe(4);
    // Built-ins before namespaced.
    expect(items[0]!.label).toMatch(/^\/(help|exit|history)$/);
    expect(items[items.length - 1]!.label).toBe("/mcp:reload");
  });

  it("returns description per item", async () => {
    const reg = createRegistry();
    registerBuiltins(reg);
    const src = buildCompletionSource(reg);
    const items = await src.list("help");
    expect(items[0]!.detail).toMatch(/slash commands/i);
  });

  it("filters by namespace prefix", async () => {
    const reg = createRegistry();
    reg.register({ name: "session:list", description: "list", source: "builtin" }, async () => {});
    reg.register({ name: "session:new", description: "new", source: "builtin" }, async () => {});
    reg.register({ name: "mcp:reload", description: "r", source: "builtin" }, async () => {});
    const src = buildCompletionSource(reg);
    const items = await src.list("session");
    expect(items.map((i) => i.label)).toEqual(["/session:list", "/session:new"]);
  });
});
