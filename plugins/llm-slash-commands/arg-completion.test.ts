import { describe, it, expect } from "bun:test";
import { computeArgSlot, buildArgCompletionSource } from "./arg-completion.ts";
import { createRegistry } from "./registry.ts";

describe("computeArgSlot", () => {
  it("returns null when line is not a slash command", () => {
    expect(computeArgSlot("hello world", 5)).toBeNull();
  });

  it("identifies slot 0 with empty query right after the command", () => {
    const r = computeArgSlot("/config:set ", 12);
    expect(r).toEqual({ name: "config:set", slotIndex: 0, prevArgs: [], query: "", anchor: 12, flagMode: false });
  });

  it("identifies slot 0 with partial token", () => {
    const r = computeArgSlot("/config:set kaiz", 16);
    expect(r).toEqual({ name: "config:set", slotIndex: 0, prevArgs: [], query: "kaiz", anchor: 12, flagMode: false });
  });

  it("identifies slot 1 with prev args populated", () => {
    const r = computeArgSlot("/config:set kaizen-config m", 27);
    expect(r).toEqual({ name: "config:set", slotIndex: 1, prevArgs: ["kaizen-config"], query: "m", anchor: 26, flagMode: false });
  });

  it("treats flags as non-positional", () => {
    const r = computeArgSlot("/config:set --project kaizen-config ", 36);
    // --project stripped from positional; slot 1 ready with prev=["kaizen-config"]
    expect(r?.slotIndex).toBe(1);
    expect(r?.prevArgs).toEqual(["kaizen-config"]);
    expect(r?.query).toBe("");
  });

  it("returns flagMode after all positional slots filled", () => {
    const r = computeArgSlot("/config:set kaizen-config model=gpt ", 36);
    expect(r?.flagMode).toBe(true);
    expect(r?.slotIndex).toBe(2);
    expect(r?.query).toBe("");
  });

  it("computes flagMode with partial flag token", () => {
    const r = computeArgSlot("/config:set kaizen-config model=gpt --pr", 40);
    expect(r?.flagMode).toBe(true);
    expect(r?.query).toBe("--pr");
  });
});

describe("buildArgCompletionSource", () => {
  function withRegistry() {
    const reg = createRegistry();
    reg.register(
      {
        name: "config:set",
        description: "x",
        source: "plugin",
        arguments: [
          { name: "plugin", complete: async () => [{ label: "kaizen-config", insertText: "kaizen-config" }] },
          { name: "key=value", complete: async (prev) => [{ label: `${prev[0]}:k=v`, insertText: `k=v` }] },
        ],
        flags: [{ name: "--project" }],
      },
      async () => {},
    );
    return reg;
  }

  it("match returns non-null for slot 0", () => {
    const src = buildArgCompletionSource(withRegistry());
    const hit = src.match!("/config:set ", 12);
    expect(hit).toEqual({ triggerPos: 12, query: "" });
  });

  it("match returns null for unknown command", () => {
    const src = buildArgCompletionSource(withRegistry());
    expect(src.match!("/nope foo", 9)).toBeNull();
  });

  it("match returns null when slotIndex past arguments and no flags remaining", () => {
    const reg = createRegistry();
    reg.register(
      { name: "noflag:cmd", description: "x", source: "plugin", arguments: [{ name: "a" }] },
      async () => {},
    );
    const src = buildArgCompletionSource(reg);
    expect(src.match!("/noflag:cmd one two ", 20)).toBeNull();
  });

  it("list returns slot 0 completions", async () => {
    const src = buildArgCompletionSource(withRegistry());
    const items = await src.list("", { line: "/config:set ", cursor: 12 });
    expect(items.map(i => i.label)).toEqual(["kaizen-config"]);
  });

  it("list returns slot 1 completions with prev populated", async () => {
    const src = buildArgCompletionSource(withRegistry());
    const items = await src.list("", { line: "/config:set kaizen-config ", cursor: 26 });
    expect(items.map(i => i.label)).toEqual(["kaizen-config:k=v"]);
  });

  it("list returns flag suggestions when positional slots are filled", async () => {
    const src = buildArgCompletionSource(withRegistry());
    const items = await src.list("", { line: "/config:set kaizen-config k=v ", cursor: 30 });
    expect(items.map(i => i.label)).toEqual(["--project"]);
  });

  it("list excludes flags already present in the line", async () => {
    const src = buildArgCompletionSource(withRegistry());
    const items = await src.list("", { line: "/config:set kaizen-config k=v --project ", cursor: 40 });
    expect(items).toEqual([]);
  });

  function withQueryUnawareSlot() {
    const reg = createRegistry();
    reg.register(
      {
        name: "qun:cmd",
        description: "x",
        source: "plugin",
        arguments: [
          // complete returns the FULL list — dispatcher should filter.
          { name: "plugin", complete: async () => [
            { label: "kaizen-config", insertText: "kaizen-config " },
            { label: "openai-llm",    insertText: "openai-llm "    },
          ] },
        ],
      },
      async () => {},
    );
    return reg;
  }

  function withSelfFilterSlot() {
    const reg = createRegistry();
    reg.register(
      {
        name: "self:cmd",
        description: "x",
        source: "plugin",
        arguments: [
          { name: "key=value",
            selfFilters: true,
            complete: async () => [
              { label: "✓ keychain", insertText: "backend=keychain " },
              { label: "  env",      insertText: "backend=env "      },
            ],
          },
        ],
      },
      async () => {},
    );
    return reg;
  }

  it("positional slot: dispatcher filters by slot query against label (substring + case-fold)", async () => {
    const src = buildArgCompletionSource(withQueryUnawareSlot());
    const items = await src.list("", { line: "/qun:cmd KAI", cursor: 12 });
    expect(items.map((i) => i.label)).toEqual(["kaizen-config"]);
  });

  it("positional slot: empty slot query returns all plugin items unchanged", async () => {
    const src = buildArgCompletionSource(withQueryUnawareSlot());
    const items = await src.list("", { line: "/qun:cmd ", cursor: 9 });
    expect(items.map((i) => i.label).sort()).toEqual(["kaizen-config", "openai-llm"]);
  });

  it("positional slot: selfFilters: true bypasses dispatcher filter", async () => {
    const src = buildArgCompletionSource(withSelfFilterSlot());
    // Query 'env' would normally filter the '✓ keychain' label out.
    // With selfFilters: true, dispatcher must NOT filter — both rows return.
    const items = await src.list("", { line: "/self:cmd env", cursor: 13 });
    expect(items.map((i) => i.label).sort()).toEqual(["  env", "✓ keychain"]);
  });
});
