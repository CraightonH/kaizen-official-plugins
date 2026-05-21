import { describe, it, expect } from "bun:test";
import { selectBackend } from "../secrets/select-backend.ts";

describe("selectBackend", () => {
  it("returns the configured default when set and registered", () => {
    expect(selectBackend({ configured: "keychain", available: ["env", "keychain"], readOnly: ["env"] }))
      .toEqual({ ok: true, scheme: "keychain" });
  });

  it("rejects when configured default is not registered", () => {
    const r = selectBackend({ configured: "vault", available: ["env", "keychain"], readOnly: ["env"] });
    if (!r.ok) {
      expect(r.error).toMatch(/defaultSecretBackend='vault'.*not registered/);
    } else {
      expect(r.ok).toBe(false);
    }
  });

  it("rejects when configured default is read-only", () => {
    const r = selectBackend({ configured: "env", available: ["env"], readOnly: ["env"] });
    if (!r.ok) {
      expect(r.error).toMatch(/env: scheme is read-only/);
    } else {
      expect(r.ok).toBe(false);
    }
  });

  it("auto-selects the sole writable backend", () => {
    expect(selectBackend({ configured: undefined, available: ["env", "keychain"], readOnly: ["env"] }))
      .toEqual({ ok: true, scheme: "keychain" });
  });

  it("rejects when no writable backends are registered", () => {
    const r = selectBackend({ configured: undefined, available: ["env"], readOnly: ["env"] });
    if (!r.ok) {
      expect(r.error).toMatch(/no writable secrets backend registered/);
    } else {
      expect(r.ok).toBe(false);
    }
  });

  it("rejects when multiple writable backends and no default", () => {
    const r = selectBackend({ configured: undefined, available: ["keychain", "vault"], readOnly: [] });
    if (!r.ok) {
      expect(r.error).toMatch(/multiple writable backends.*keychain, vault/);
    } else {
      expect(r.ok).toBe(false);
    }
  });
});
