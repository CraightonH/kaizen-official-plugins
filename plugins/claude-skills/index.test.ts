import { describe, expect, it } from "bun:test";
import plugin from "./index.ts";

describe("claude-skills manifest smoke", () => {
  it("declares the required plugin metadata", () => {
    expect(plugin.name).toBe("claude-skills");
    expect(plugin.apiVersion).toBe("3.0.0");
    expect(plugin.permissions?.tier).toBe("unscoped");
    expect(plugin.services?.consumes).toContain("skills:registry");
    expect(plugin.services?.consumes).toContain("config:store");
  });
});
