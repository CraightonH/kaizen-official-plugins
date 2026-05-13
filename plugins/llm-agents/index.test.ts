import { describe, expect, it } from "bun:test";
import plugin from "./index.ts";

describe("llm-agents manifest smoke", () => {
  it("declares the required plugin metadata", () => {
    expect(plugin.name).toBe("llm-agents");
    expect(plugin.apiVersion).toBe("3.0.0");
    expect(plugin.permissions?.tier).toBe("unscoped");
    expect(plugin.services?.provides).toContain("agents:registry");
    expect(plugin.services?.consumes).toContain("events:vocabulary");
  });
});
