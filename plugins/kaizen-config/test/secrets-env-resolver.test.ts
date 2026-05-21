import { describe, it, expect } from "bun:test";
import { createEnvResolver } from "../secrets/env-resolver.ts";

describe("env-resolver", () => {
  it("declares scheme=env and is readOnly", () => {
    const r = createEnvResolver({});
    expect(r.scheme).toBe("env");
    expect(r.readOnly).toBe(true);
  });

  it("returns the env var value for get()", async () => {
    const r = createEnvResolver({ MY_KEY: "hello" });
    expect(await r.get("MY_KEY")).toBe("hello");
  });

  it("throws a clear error when the env var is unset", async () => {
    const r = createEnvResolver({});
    await expect(r.get("MISSING")).rejects.toThrow(/env:MISSING/);
  });

  it("throws on set()", async () => {
    const r = createEnvResolver({});
    await expect(r.set?.("X", "y")).rejects.toThrow(/read-only/);
  });

  it("throws on delete()", async () => {
    const r = createEnvResolver({});
    await expect(r.delete?.("X")).rejects.toThrow(/read-only/);
  });
});
