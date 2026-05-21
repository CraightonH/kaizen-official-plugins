import { describe, it, expect } from "bun:test";
import { redactValue, redactSnapshot } from "../secrets/redact.ts";
import type { ConfigSchema } from "llm-contracts/public";

describe("redactValue", () => {
  it("returns value unchanged when field schema is absent", () => {
    expect(redactValue("plaintext", undefined)).toBe("plaintext");
  });

  it("returns value unchanged when field schema is not a secret", () => {
    expect(redactValue("plaintext", { type: "string" })).toBe("plaintext");
  });

  it("returns <redacted> for plaintext secret value", () => {
    expect(redactValue("tvly-abc", { type: "string", secret: true })).toBe("<redacted>");
  });

  it("returns <redacted:scheme> for SecretRef secret value", () => {
    expect(redactValue({ $ref: "keychain:plug/api" }, { type: "string", secret: true }))
      .toBe("<redacted:keychain>");
  });

  it("returns <redacted> for non-string value on secret field (defensive)", () => {
    expect(redactValue(123, { type: "string", secret: true })).toBe("<redacted>");
  });
});

describe("redactSnapshot", () => {
  it("redacts only secret-marked fields, leaving others intact", () => {
    const schema: ConfigSchema<{ apiKey: string; model: string }> = {
      apiKey: { type: "string", secret: true },
      model: { type: "string" },
    };
    const snap = { apiKey: "tvly-abc", model: "gpt-4" };
    expect(redactSnapshot(snap, schema)).toEqual({
      apiKey: "<redacted>",
      model: "gpt-4",
    });
  });

  it("handles SecretRef in snapshot", () => {
    const schema: ConfigSchema<{ apiKey: string }> = {
      apiKey: { type: "string", secret: true },
    };
    const snap = { apiKey: { $ref: "keychain:plug/api" } };
    expect(redactSnapshot(snap as unknown as { apiKey: string }, schema)).toEqual({
      apiKey: "<redacted:keychain>",
    });
  });

  it("returns snapshot unchanged when schema is undefined", () => {
    const snap = { apiKey: "tvly-abc" };
    expect(redactSnapshot(snap, undefined)).toEqual(snap);
  });
});
