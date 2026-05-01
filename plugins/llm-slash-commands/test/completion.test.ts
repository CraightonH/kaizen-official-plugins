import { describe, it, expect } from "bun:test";
import { createRegistry } from "../registry.ts";
import { registerBuiltins } from "../builtins.ts";
import { buildCompletionSource } from "../completion.ts";

describe("buildCompletionSource", () => {
  it("returns trigger='/' source", () => {
    const reg = createRegistry();
    const src = buildCompletionSource(reg);
    expect(src.trigger).toBe("/");
  });

  it("filters by prefix after the slash", async () => {
    const reg = createRegistry();
    registerBuiltins(reg);
    reg.register({ name: "mcp:reload", description: "r", source: "plugin" }, async () => {});
    const src = buildCompletionSource(reg);
    const items = await src.list("/he", 3);
    expect(items.map((i) => i.label)).toEqual(["/help"]);
    expect(items[0]!.insertText).toBe("/help ");
  });

  it("returns all when prefix empty", async () => {
    const reg = createRegistry();
    registerBuiltins(reg);
    reg.register({ name: "mcp:reload", description: "r", source: "plugin" }, async () => {});
    const src = buildCompletionSource(reg);
    const items = await src.list("/", 1);
    expect(items.length).toBe(3);
    // Built-ins before namespaced.
    expect(items[0]!.label).toMatch(/^\/(help|exit)$/);
    expect(items[items.length - 1]!.label).toBe("/mcp:reload");
  });

  it("returns description per item", async () => {
    const reg = createRegistry();
    registerBuiltins(reg);
    const src = buildCompletionSource(reg);
    const items = await src.list("/help", 5);
    expect(items[0]!.description).toMatch(/slash commands/i);
  });

  it("returns [] when input doesn't start with /", async () => {
    const reg = createRegistry();
    registerBuiltins(reg);
    const src = buildCompletionSource(reg);
    expect(await src.list("hello", 5)).toEqual([]);
  });
});
