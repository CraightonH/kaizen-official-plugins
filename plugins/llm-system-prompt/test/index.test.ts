import { describe, expect, it } from "bun:test";
import plugin from "../index.ts";

describe("llm-system-prompt plugin manifest", () => {
  it("exports a KaizenPlugin with the correct name and apiVersion", () => {
    expect(plugin.name).toBe("llm-system-prompt");
    expect(plugin.apiVersion).toBe("3.0.0");
    expect(plugin.permissions?.tier).toBe("trusted");
  });

  it("provides prompt:system", () => {
    expect(plugin.services?.provides).toContain("prompt:system");
  });
});
