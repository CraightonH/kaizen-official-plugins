import { describe, it, expect, mock } from "bun:test";
import { makeRegistry, makeRegistryHandle } from "../registry.ts";
import type { InternalAgentManifest } from "../frontmatter.ts";

const m: InternalAgentManifest = {
  name: "code-reviewer",
  description: "review",
  systemPrompt: "be terse",
  toolFilter: { names: ["read_*"] },
  sourcePath: "/x/code-reviewer.md",
  scope: "user",
};

describe("makeRegistry", () => {
  it("list() returns public view (no sourcePath/scope/modelOverride)", () => {
    const r = makeRegistry([m]);
    const list = r.service.list();
    expect(list.length).toBe(1);
    expect((list[0] as any).sourcePath).toBeUndefined();
    expect((list[0] as any).scope).toBeUndefined();
    expect(list[0]!.name).toBe("code-reviewer");
  });

  it("getInternal returns the internal record by name", () => {
    const r = makeRegistry([m]);
    expect(r.getInternal("code-reviewer")?.sourcePath).toBe("/x/code-reviewer.md");
    expect(r.getInternal("missing")).toBeUndefined();
  });

  it("register() rejects non-runtime: prefix", () => {
    const r = makeRegistry([]);
    expect(() => r.service.register({ name: "foo", description: "d", systemPrompt: "p" })).toThrow(/runtime:/);
  });

  it("register() refuses to overwrite an existing name", () => {
    const r = makeRegistry([m]);
    expect(() => r.service.register({ name: "code-reviewer", description: "d", systemPrompt: "p" })).toThrow();
  });

  it("register() accepts runtime: name and unregister removes it", () => {
    const r = makeRegistry([]);
    const off = r.service.register({ name: "runtime:adhoc", description: "d", systemPrompt: "p" });
    expect(r.service.list().some((x) => x.name === "runtime:adhoc")).toBe(true);
    off();
    expect(r.service.list().some((x) => x.name === "runtime:adhoc")).toBe(false);
  });
});

describe("makeRegistry onChange callback", () => {
  it("register(runtime: agent) invokes onChange once", () => {
    const onChange = mock(() => {});
    const r = makeRegistry([], onChange);
    r.service.register({ name: "runtime:test", description: "d", systemPrompt: "p" });
    expect(onChange.mock.calls.length).toBe(1);
  });

  it("returned unregister closure invokes onChange again", () => {
    const onChange = mock(() => {});
    const r = makeRegistry([], onChange);
    const off = r.service.register({ name: "runtime:test", description: "d", systemPrompt: "p" });
    onChange.mockClear();
    off();
    expect(onChange.mock.calls.length).toBe(1);
  });

  it("RegistryHandle.setInner invokes onChange once on swap", () => {
    const onChange = mock(() => {});
    const handle = makeRegistryHandle(makeRegistry([]));
    const next = makeRegistry([]);
    handle.setInner(next, undefined, onChange);
    expect(onChange.mock.calls.length).toBe(1);
  });
});

describe("RegistryHandle errors slot", () => {
  it("initial handle has empty errors", () => {
    const handle = makeRegistryHandle(makeRegistry([]));
    expect(handle.getErrors()).toEqual([]);
  });

  it("setInner stores errors and getErrors returns a defensive copy", () => {
    const handle = makeRegistryHandle(makeRegistry([]));
    const errors = [{ path: "/x/a.md", message: "boom" }];
    handle.setInner(makeRegistry([]), errors);
    const out1 = handle.getErrors();
    expect(out1).toEqual([{ path: "/x/a.md", message: "boom" }]);
    out1.push({ path: "/y", message: "leak" });
    expect(handle.getErrors()).toEqual([{ path: "/x/a.md", message: "boom" }]);
  });
});
