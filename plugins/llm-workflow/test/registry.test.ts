import { describe, it, expect } from "bun:test";
import { makeRegistry, makeRegistryHandle } from "../registry.ts";
import type { WorkflowManifest } from "llm-contracts/public";

function mf(name: string, source = "// noop"): WorkflowManifest {
  return {
    meta: { name, description: `Desc of ${name}` },
    source,
    scope: "user",
    sourcePath: `<runtime>`,
  };
}

describe("registry", () => {
  it("list() returns public manifests", () => {
    const r = makeRegistry([mf("foo"), mf("bar")]);
    const names = r.service.list().map((m) => m.meta.name).sort();
    expect(names).toEqual(["bar", "foo"]);
  });

  it("get() returns the matching manifest, or undefined", () => {
    const r = makeRegistry([mf("foo")]);
    expect(r.service.get("foo")?.meta.name).toBe("foo");
    expect(r.service.get("missing")).toBeUndefined();
  });

  it("register() requires runtime: prefix", () => {
    const r = makeRegistry([]);
    expect(() => r.service.register(mf("plain"))).toThrow(/runtime:/);
    const unregister = r.service.register(mf("runtime:dynamic"));
    expect(r.service.get("runtime:dynamic")?.meta.name).toBe("runtime:dynamic");
    unregister();
    expect(r.service.get("runtime:dynamic")).toBeUndefined();
  });

  it("register() rejects collision", () => {
    const r = makeRegistry([mf("runtime:x")]);
    expect(() => r.service.register(mf("runtime:x"))).toThrow(/already registered/);
  });

  it("handle.setInner swaps the inner registry while preserving the service reference", () => {
    const h = makeRegistryHandle(makeRegistry([mf("foo")]));
    const svc = h.service;
    expect(svc.list().length).toBe(1);
    h.setInner(makeRegistry([mf("bar"), mf("baz")]));
    expect(svc.list().length).toBe(2);
  });
});
