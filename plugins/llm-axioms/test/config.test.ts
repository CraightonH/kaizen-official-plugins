import { describe, it, expect } from "bun:test";
import { DEFAULT_CONFIG, CONFIG_SCHEMA } from "../config.ts";

describe("DEFAULT_CONFIG", () => {
  it("uses the expected defaults", () => {
    expect(DEFAULT_CONFIG.axiomsDir).toBe("~/.kaizen/plugins/llm-axioms/sessions");
    expect(DEFAULT_CONFIG.injectionByteCap).toBe(4096);
    expect(DEFAULT_CONFIG.methodologyEnabled).toBe(true);
    expect(DEFAULT_CONFIG.workspaceEnabled).toBe(true);
    expect(DEFAULT_CONFIG.staleTempMs).toBe(60_000);
    expect(DEFAULT_CONFIG.methodologyPriority).toBe(50);
    expect(DEFAULT_CONFIG.workspacePriority).toBe(180);
  });
});

describe("CONFIG_SCHEMA", () => {
  it("declares the expected fields", () => {
    expect(Object.keys(CONFIG_SCHEMA).sort()).toEqual(
      [
        "axiomsDir",
        "injectionByteCap",
        "methodologyEnabled",
        "methodologyPriority",
        "staleTempMs",
        "workspaceEnabled",
        "workspacePriority",
      ].sort(),
    );
    expect(CONFIG_SCHEMA.injectionByteCap.type).toBe("number");
    expect(CONFIG_SCHEMA.methodologyEnabled.type).toBe("boolean");
    expect(CONFIG_SCHEMA.workspaceEnabled.type).toBe("boolean");
    expect(CONFIG_SCHEMA.axiomsDir.type).toBe("string");
    expect(CONFIG_SCHEMA.staleTempMs.type).toBe("number");
    expect(CONFIG_SCHEMA.methodologyPriority.type).toBe("number");
    expect(CONFIG_SCHEMA.workspacePriority.type).toBe("number");
  });
});
