// plugins/kaizen-config/test/envvars.test.ts
import { describe, it, expect } from "bun:test";
import { applyEnvOverrides } from "../envvars.ts";
import type { ConfigSchema } from "../schema.ts";

describe("applyEnvOverrides", () => {
  const schema: ConfigSchema<any> = {
    apiKey: { type: "string" },
    timeoutMs: { type: "number", integer: true },
    enabled: { type: "boolean" },
  };

  it("string env value overrides merged value", () => {
    const { value, resolution } = applyEnvOverrides(
      { apiKey: "from-file" },
      schema,
      { apiKey: "MY_KEY" },
      { MY_KEY: "from-env" },
    );
    expect((value as any).apiKey).toBe("from-env");
    expect(resolution.apiKey).toBe("env");
  });

  it("number env value is parsed", () => {
    const { value } = applyEnvOverrides(
      { timeoutMs: 1000 },
      schema,
      { timeoutMs: "MY_TIMEOUT" },
      { MY_TIMEOUT: "5000" },
    );
    expect((value as any).timeoutMs).toBe(5000);
  });

  it("boolean env value is parsed (true/false strings only)", () => {
    const { value } = applyEnvOverrides(
      { enabled: false },
      schema,
      { enabled: "MY_FLAG" },
      { MY_FLAG: "true" },
    );
    expect((value as any).enabled).toBe(true);
  });

  it("empty env value is ignored", () => {
    const { value, resolution } = applyEnvOverrides(
      { apiKey: "from-file" },
      schema,
      { apiKey: "MY_KEY" },
      { MY_KEY: "" },
    );
    expect((value as any).apiKey).toBe("from-file");
    expect(resolution.apiKey).not.toBe("env");
  });

  it("missing env variable is ignored", () => {
    const { value } = applyEnvOverrides(
      { apiKey: "from-file" },
      schema,
      { apiKey: "MY_KEY" },
      {},
    );
    expect((value as any).apiKey).toBe("from-file");
  });

  it("unparseable number env throws", () => {
    expect(() =>
      applyEnvOverrides(
        { timeoutMs: 1 },
        schema,
        { timeoutMs: "MY_TIMEOUT" },
        { MY_TIMEOUT: "not-a-number" },
      ),
    ).toThrow(/MY_TIMEOUT/);
  });
});
