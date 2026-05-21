import { describe, it, expect } from "bun:test";
import { createRegistry } from "../secrets/registry.ts";
import type { SecretsResolver } from "llm-contracts/public";

function fakeResolver(over: Partial<SecretsResolver> & { scheme: string }): SecretsResolver {
  const data = new Map<string, string>();
  return {
    scheme: over.scheme,
    readOnly: over.readOnly,
    get: over.get ?? (async (k) => {
      const v = data.get(k);
      if (v === undefined) throw new Error(`${over.scheme}:${k} not found`);
      return v;
    }),
    set: over.set ?? (async (k, v) => { data.set(k, v); }),
    delete: over.delete ?? (async (k) => { data.delete(k); }),
    list: over.list,
  };
}

describe("registry", () => {
  it("starts empty", () => {
    const r = createRegistry();
    expect(r.schemes()).toEqual([]);
    expect(r.has("env")).toBe(false);
  });

  it("register adds a scheme; unregister fn removes it", () => {
    const r = createRegistry();
    const off = r.register(fakeResolver({ scheme: "foo" }));
    expect(r.schemes()).toEqual(["foo"]);
    expect(r.has("foo")).toBe(true);
    off();
    expect(r.schemes()).toEqual([]);
    expect(r.has("foo")).toBe(false);
  });

  it("register throws on duplicate scheme", () => {
    const r = createRegistry();
    r.register(fakeResolver({ scheme: "foo" }));
    expect(() => r.register(fakeResolver({ scheme: "foo" }))).toThrow(/already registered/);
  });

  it("resolve returns the backend value", async () => {
    const r = createRegistry();
    const f = fakeResolver({ scheme: "foo" });
    await f.set!("k1", "value-1");
    r.register(f);
    expect(await r.resolve({ $ref: "foo:k1" })).toBe("value-1");
  });

  it("resolve throws on unknown scheme", async () => {
    const r = createRegistry();
    await expect(r.resolve({ $ref: "nope:k" })).rejects.toThrow(/no resolver registered for scheme 'nope'/);
  });

  it("resolve throws on malformed ref (no colon)", async () => {
    const r = createRegistry();
    await expect(r.resolve({ $ref: "malformed" })).rejects.toThrow(/malformed \$ref/);
  });

  it("store writes through and returns the canonical ref", async () => {
    const r = createRegistry();
    const f = fakeResolver({ scheme: "foo" });
    r.register(f);
    const ref = await r.store("foo", "plug/api", "secret-value");
    expect(ref).toEqual({ $ref: "foo:plug/api" });
    expect(await r.resolve(ref)).toBe("secret-value");
  });

  it("store throws on unknown scheme", async () => {
    const r = createRegistry();
    await expect(r.store("nope", "k", "v")).rejects.toThrow(/no resolver registered/);
  });

  it("store throws on read-only scheme", async () => {
    const r = createRegistry();
    r.register(fakeResolver({ scheme: "env", readOnly: true }));
    await expect(r.store("env", "k", "v")).rejects.toThrow(/read-only/);
  });

  it("delete invokes backend delete and is a no-op if missing", async () => {
    const r = createRegistry();
    const f = fakeResolver({ scheme: "foo" });
    await f.set!("k1", "v1");
    r.register(f);
    await r.delete({ $ref: "foo:k1" });
    await expect(f.get("k1")).rejects.toThrow();
    await r.delete({ $ref: "foo:k1" });
  });

  it("delete throws on read-only scheme", async () => {
    const r = createRegistry();
    r.register(fakeResolver({ scheme: "env", readOnly: true }));
    await expect(r.delete({ $ref: "env:k" })).rejects.toThrow(/read-only/);
  });
});
