import { describe, it, expect } from "bun:test";
import { loadConfig, DEFAULT_CONFIG, defaultConfigPath, type ConfigDeps } from "../config.ts";

function deps(overrides: Partial<ConfigDeps> = {}): ConfigDeps {
  return {
    home: "/home/user",
    env: {},
    readFile: async () => { const e: any = new Error("ENOENT"); e.code = "ENOENT"; throw e; },
    log: () => {},
    ...overrides,
  };
}

describe("config", () => {
  it("returns defaults when no file", async () => {
    const cfg = await loadConfig(deps());
    expect(cfg).toEqual(DEFAULT_CONFIG);
  });

  it("default path uses ~/.kaizen/plugins/llm-codemode-dispatch", () => {
    expect(defaultConfigPath("/home/u")).toBe("/home/u/.kaizen/plugins/llm-codemode-dispatch/config.json");
  });

  it("KAIZEN_LLM_CODEMODE_CONFIG env overrides path", async () => {
    let read = "";
    await loadConfig(deps({
      env: { KAIZEN_LLM_CODEMODE_CONFIG: "/tmp/x.json" },
      readFile: async (p) => { read = p; return "{}"; },
    }));
    expect(read).toBe("/tmp/x.json");
  });

  it("merges user config over defaults", async () => {
    const cfg = await loadConfig(deps({
      readFile: async () => JSON.stringify({ timeoutMs: 5000, maxStdoutBytes: 1024 }),
    }));
    expect(cfg.timeoutMs).toBe(5000);
    expect(cfg.maxStdoutBytes).toBe(1024);
    expect(cfg.maxReturnBytes).toBe(DEFAULT_CONFIG.maxReturnBytes);
  });

  it("rejects malformed JSON", async () => {
    await expect(loadConfig(deps({ readFile: async () => "not json" }))).rejects.toThrow(/malformed/);
  });

  it("rejects non-positive timeoutMs", async () => {
    await expect(loadConfig(deps({ readFile: async () => JSON.stringify({ timeoutMs: 0 }) }))).rejects.toThrow(/timeoutMs/);
  });

  it("rejects unknown sandbox value", async () => {
    await expect(loadConfig(deps({ readFile: async () => JSON.stringify({ sandbox: "quickjs" }) }))).rejects.toThrow(/sandbox/);
  });
});
