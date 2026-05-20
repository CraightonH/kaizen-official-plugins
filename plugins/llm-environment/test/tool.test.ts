import { describe, expect, it } from "bun:test";
import { makeEnvToolHandlers, ENVIRONMENT_REFRESH_SCHEMA } from "../tool.ts";

describe("makeEnvToolHandlers", () => {
  it("schema name, description, tags, and empty parameters", () => {
    expect(ENVIRONMENT_REFRESH_SCHEMA.name).toBe("environment_refresh");
    expect(ENVIRONMENT_REFRESH_SCHEMA.description).toMatch(/snapshot/i);
    expect((ENVIRONMENT_REFRESH_SCHEMA as { tags?: string[] }).tags).toEqual(["environment", "diagnostic", "synthetic"]);
    expect(ENVIRONMENT_REFRESH_SCHEMA.parameters).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
  });

  it("handler invokes refresh and returns ok payload", async () => {
    let calls = 0;
    const { refresh } = makeEnvToolHandlers({
      refresh: async () => { calls += 1; },
    });
    const result = await refresh.handler({}, {} as never);
    expect(calls).toBe(1);
    expect(result).toEqual({ ok: true, message: "environment refreshed" });
  });
});
