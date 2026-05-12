import { describe, expect, it, mock } from "bun:test";
import { createRegistry } from "../registry.ts";

describe("registry — basic operations", () => {
  it("starts at generation 0 with an empty list", () => {
    const r = createRegistry({ emit: mock(() => Promise.resolve()) });
    expect(r.generation()).toBe(0);
    expect(r.list()).toEqual([]);
  });

  it("register increments generation and emits prompt:rebuilt", async () => {
    const emit = mock(async (_e: string, _p: unknown) => {});
    const r = createRegistry({ emit });
    r.register({ id: "a", priority: 100, render: () => "A" });
    expect(r.generation()).toBe(1);
    expect(emit).toHaveBeenCalledWith("prompt:rebuilt", { generation: 1 });
  });

  it("emits using the configured prompt rebuilt event name", async () => {
    const emit = mock(async (_e: string, _p: unknown) => {});
    const r = createRegistry({ emit, events: { promptRebuilt: "custom:rebuilt" } });
    r.register({ id: "a", priority: 100, render: () => "A" });
    expect(emit).toHaveBeenCalledWith("custom:rebuilt", { generation: 1 });
  });

  it("assemble returns sections sorted by priority", async () => {
    const r = createRegistry({ emit: mock(() => Promise.resolve()) });
    r.register({ id: "b", priority: 200, render: () => "BBB" });
    r.register({ id: "a", priority: 100, render: () => "AAA" });
    const out = await r.assemble();
    expect(out.indexOf("AAA")).toBeLessThan(out.indexOf("BBB"));
  });

  it("assemble applies section title as `## {title}` header", async () => {
    const r = createRegistry({ emit: mock(() => Promise.resolve()) });
    r.register({ id: "a", priority: 100, render: () => "body", title: "Heading" });
    const out = await r.assemble();
    expect(out).toContain("## Heading\nbody");
  });

  it("assemble omits sections that render empty", async () => {
    const r = createRegistry({ emit: mock(() => Promise.resolve()) });
    r.register({ id: "a", priority: 100, render: () => "" });
    r.register({ id: "b", priority: 200, render: () => "kept" });
    const out = await r.assemble();
    expect(out).not.toMatch(/^\s*$/);
    expect(out).toContain("kept");
  });

  it("assemble is memoized on generation — same string instance until generation changes", async () => {
    const r = createRegistry({ emit: mock(() => Promise.resolve()) });
    r.register({ id: "a", priority: 100, render: () => "AAA" });
    const s1 = await r.assemble();
    const s2 = await r.assemble();
    expect(s1).toBe(s2); // identity, not equality
  });
});

describe("registry — handle-scoped ownership", () => {
  it("handle.unregister removes the section and bumps generation", async () => {
    const emit = mock(async (_e: string, _p: unknown) => {});
    const r = createRegistry({ emit });
    const h = r.register({ id: "a", priority: 100, render: () => "AAA" });
    const genAfterRegister = r.generation();
    h.unregister();
    expect(r.generation()).toBeGreaterThan(genAfterRegister);
    expect(r.list()).toEqual([]);
  });

  it("handle.unregister is idempotent — second call is no-op", () => {
    const r = createRegistry({ emit: mock(() => Promise.resolve()) });
    const h = r.register({ id: "a", priority: 100, render: () => "AAA" });
    h.unregister();
    const gen = r.generation();
    h.unregister();
    expect(r.generation()).toBe(gen);
  });

  it("handle.bumpGeneration increments generation and emits", async () => {
    const emit = mock(async (_e: string, _p: unknown) => {});
    const r = createRegistry({ emit });
    const h = r.register({ id: "a", priority: 100, render: () => "AAA" });
    emit.mockClear();
    h.bumpGeneration();
    expect(emit).toHaveBeenCalledWith("prompt:rebuilt", expect.any(Object));
  });

  it("handle.bumpGeneration after unregister is a no-op", () => {
    const r = createRegistry({ emit: mock(() => Promise.resolve()) });
    const h = r.register({ id: "a", priority: 100, render: () => "AAA" });
    h.unregister();
    const gen = r.generation();
    h.bumpGeneration();
    expect(r.generation()).toBe(gen);
  });

  it("registering an id already owned by a live handle throws", () => {
    const r = createRegistry({ emit: mock(() => Promise.resolve()) });
    const h1 = r.register({ id: "a", priority: 100, render: () => "h1" });
    expect(() => {
      r.register({ id: "a", priority: 100, render: () => "h2" });
    }).toThrow(/already registered/);
    h1.unregister();
    expect(() => {
      r.register({ id: "a", priority: 100, render: () => "h2" });
    }).not.toThrow();
  });
});

describe("registry — disable/enable (diagnostic)", () => {
  it("disabled section renders empty without leaving the registry", async () => {
    const r = createRegistry({ emit: mock(() => Promise.resolve()) });
    r.register({ id: "a", priority: 100, render: () => "AAA" });
    r.disable("a");
    const out = await r.assemble();
    expect(out).not.toContain("AAA");
    expect(r.list().map((s) => s.id)).toContain("a");
  });

  it("enable restores rendering", async () => {
    const r = createRegistry({ emit: mock(() => Promise.resolve()) });
    r.register({ id: "a", priority: 100, render: () => "AAA" });
    r.disable("a");
    r.enable("a");
    const out = await r.assemble();
    expect(out).toContain("AAA");
  });
});

describe("registry — render error handling", () => {
  it("a render() that throws is rendered as an inline error block, not propagated", async () => {
    const r = createRegistry({ emit: mock(() => Promise.resolve()) });
    r.register({ id: "broken", priority: 100, render: () => { throw new Error("boom"); } });
    r.register({ id: "ok", priority: 200, render: () => "OK" });
    const out = await r.assemble();
    expect(out).toContain("OK");
    expect(out).toContain("broken");
    expect(out).toContain("boom");
  });
});
