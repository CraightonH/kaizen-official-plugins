import { describe, it, expect } from "bun:test";
import { DEFAULT_CONFIG, CONFIG_SCHEMA } from "../config.ts";

describe("config", () => {
  it("DEFAULT_CONFIG is frozen and matches spec defaults", () => {
    expect(Object.isFrozen(DEFAULT_CONFIG)).toBe(true);
    expect(DEFAULT_CONFIG.userDir).toBe("~/.kaizen/workflows");
    expect(DEFAULT_CONFIG.projectDir).toBe(".kaizen/workflows");
    expect(DEFAULT_CONFIG.maxConcurrency).toBeNull();
    expect(DEFAULT_CONFIG.maxLifetimeAgents).toBe(1000);
    expect(DEFAULT_CONFIG.timeoutMs).toBe(600000);
    expect(DEFAULT_CONFIG.workerGracefulShutdownMs).toBe(1000);
    expect(DEFAULT_CONFIG.metaParse.maxFileBytes).toBe(65536);
  });

  it("CONFIG_SCHEMA is a JSON Schema with the expected property names", () => {
    expect(CONFIG_SCHEMA.type).toBe("object");
    const props = (CONFIG_SCHEMA as any).properties;
    for (const k of ["userDir","projectDir","maxConcurrency","maxLifetimeAgents","timeoutMs","workerGracefulShutdownMs","metaParse"]) {
      expect(props[k]).toBeDefined();
    }
  });
});
