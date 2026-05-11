import { describe, expect, it } from "bun:test";
import plugin from "./index.ts";

describe("llm-driver manifest smoke", () => {
  it("declares the required plugin metadata", () => {
    expect(plugin.name).toBe("llm-driver");
    expect(plugin.apiVersion).toBe("3.0.0");
    expect(plugin.driver).toBe(true);
    expect(plugin.permissions?.tier).toBe("unscoped");
    expect(plugin.services?.provides).toContain("driver:run-conversation");
  });
});
