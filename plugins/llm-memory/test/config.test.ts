import { describe, it, expect, mock } from "bun:test";
import { loadConfig, DEFAULT_CONFIG, type ConfigDeps } from "../config.ts";

function makeDeps(overrides: Partial<ConfigDeps> = {}): ConfigDeps {
  return {
    home: "/home/u",
    env: {},
    readFile: async () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); },
    log: mock(() => {}),
    ...overrides,
  };
}

describe("loadConfig", () => {
  it("returns defaults when file is absent", async () => {
    const cfg = await loadConfig(makeDeps());
    expect(cfg).toEqual(DEFAULT_CONFIG);
  });
  it("honors KAIZEN_LLM_MEMORY_CONFIG env override", async () => {
    let path = "";
    const cfg = await loadConfig(makeDeps({
      env: { KAIZEN_LLM_MEMORY_CONFIG: "/etc/m.json" },
      readFile: async (p: string) => { path = p; return JSON.stringify({ injectionByteCap: 4096 }); },
    }));
    expect(path).toBe("/etc/m.json");
    expect(cfg.injectionByteCap).toBe(4096);
  });
  it("merges file values over defaults", async () => {
    const cfg = await loadConfig(makeDeps({
      readFile: async () => JSON.stringify({ autoExtract: true, denyTypes: ["feedback"] }),
    }));
    expect(cfg.autoExtract).toBe(true);
    expect(cfg.denyTypes).toEqual(["feedback"]);
    expect(cfg.injectionByteCap).toBe(2048);
  });
  it("throws on malformed JSON", async () => {
    await expect(loadConfig(makeDeps({ readFile: async () => "{not-json" })))
      .rejects.toThrow(/llm-memory config.*malformed/i);
  });
  it("rejects non-positive injectionByteCap", async () => {
    await expect(loadConfig(makeDeps({ readFile: async () => JSON.stringify({ injectionByteCap: 0 }) })))
      .rejects.toThrow();
  });
  it("rejects unknown denyTypes entries", async () => {
    await expect(loadConfig(makeDeps({ readFile: async () => JSON.stringify({ denyTypes: ["nonsense"] }) })))
      .rejects.toThrow();
  });
});
