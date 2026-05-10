// plugins/llm-tavily-search/test/config.test.ts
import { describe, it, expect } from "bun:test";
import { loadConfig, DEFAULT_CONFIG } from "../config.ts";

function makeDeps(overrides: Partial<Parameters<typeof loadConfig>[0]> = {}) {
  return {
    home: "/home/test",
    env: {} as Record<string, string | undefined>,
    readFile: async (_p: string) => { const e: any = new Error("noent"); e.code = "ENOENT"; throw e; },
    log: () => {},
    ...overrides,
  };
}

describe("llm-tavily-search config", () => {
  it("returns defaults when no config file present", async () => {
    const cfg = await loadConfig(makeDeps());
    expect(cfg.endpoint).toBe(DEFAULT_CONFIG.endpoint);
    expect(cfg.apiKey).toBe("");
  });

  it("pulls apiKey from TAVILY_API_KEY env", async () => {
    const cfg = await loadConfig(makeDeps({ env: { TAVILY_API_KEY: "tvly-abc" } }));
    expect(cfg.apiKey).toBe("tvly-abc");
  });

  it("merges JSON config and respects custom apiKeyEnv", async () => {
    const cfg = await loadConfig(makeDeps({
      env: { MY_KEY: "tvly-xyz" },
      readFile: async () => JSON.stringify({ apiKeyEnv: "MY_KEY", defaultMaxResults: 10 }),
    }));
    expect(cfg.apiKey).toBe("tvly-xyz");
    expect(cfg.defaultMaxResults).toBe(10);
  });

  it("rejects malformed JSON", async () => {
    await expect(loadConfig(makeDeps({ readFile: async () => "not json" }))).rejects.toThrow(/malformed/);
  });

  it("validates ranges", async () => {
    await expect(loadConfig(makeDeps({ readFile: async () => JSON.stringify({ defaultMaxResults: 99 }) }))).rejects.toThrow(/defaultMaxResults/);
  });
});
