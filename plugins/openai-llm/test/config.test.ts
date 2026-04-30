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
  it("returns defaults when file is absent and logs the expected path", async () => {
    const log = mock(() => {});
    const cfg = await loadConfig(makeDeps({ log }));
    expect(cfg).toEqual(DEFAULT_CONFIG);
    expect(log).toHaveBeenCalled();
    const arg = (log.mock.calls[0]?.[0] ?? "") as string;
    expect(arg).toContain("/home/u/.kaizen/plugins/openai-llm/config.json");
  });

  it("honors KAIZEN_OPENAI_LLM_CONFIG env override", async () => {
    let readPath = "";
    const cfg = await loadConfig(makeDeps({
      env: { KAIZEN_OPENAI_LLM_CONFIG: "/etc/openai.json" },
      readFile: async (p: string) => { readPath = p; return JSON.stringify({ defaultModel: "x" }); },
    }));
    expect(readPath).toBe("/etc/openai.json");
    expect(cfg.defaultModel).toBe("x");
  });

  it("merges file values over defaults (deep on `retry`)", async () => {
    const cfg = await loadConfig(makeDeps({
      readFile: async () => JSON.stringify({
        baseUrl: "https://api.openai.com/v1",
        retry: { maxAttempts: 5 },
      }),
    }));
    expect(cfg.baseUrl).toBe("https://api.openai.com/v1");
    expect(cfg.retry.maxAttempts).toBe(5);
    expect(cfg.retry.initialDelayMs).toBe(DEFAULT_CONFIG.retry.initialDelayMs);
    expect(cfg.retry.jitter).toBe("full");
  });

  it("env var named by `apiKeyEnv` overrides apiKey", async () => {
    const cfg = await loadConfig(makeDeps({
      env: { OPENAI_API_KEY: "sk-real" },
      readFile: async () => JSON.stringify({ apiKey: "ignored", apiKeyEnv: "OPENAI_API_KEY" }),
    }));
    expect(cfg.apiKey).toBe("sk-real");
  });

  it("throws on malformed JSON", async () => {
    await expect(loadConfig(makeDeps({
      readFile: async () => "{not-json",
    }))).rejects.toThrow(/openai-llm config.*malformed/i);
  });

  it("rejects negative timeouts and maxAttempts < 1", async () => {
    await expect(loadConfig(makeDeps({
      readFile: async () => JSON.stringify({ requestTimeoutMs: -1 }),
    }))).rejects.toThrow();

    await expect(loadConfig(makeDeps({
      readFile: async () => JSON.stringify({ retry: { maxAttempts: 0 } }),
    }))).rejects.toThrow();
  });
});
