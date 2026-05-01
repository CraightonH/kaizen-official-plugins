import { describe, it, expect, mock } from "bun:test";
import { loadConfig, DEFAULT_CONFIG, type ConfigDeps } from "../config.ts";

function makeDeps(overrides: Partial<ConfigDeps> = {}): ConfigDeps {
  return {
    home: "/home/u",
    cwd: "/work/proj",
    env: {},
    readFile: async () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); },
    log: mock(() => {}),
    ...overrides,
  };
}

describe("loadConfig", () => {
  it("returns defaults when file is absent and resolves dirs", async () => {
    const cfg = await loadConfig(makeDeps());
    expect(cfg.maxDepth).toBe(DEFAULT_CONFIG.maxDepth);
    expect(cfg.resolvedUserDir).toBe("/home/u/.kaizen/agents");
    expect(cfg.resolvedProjectDir).toBe("/work/proj/.kaizen/agents");
  });

  it("honors KAIZEN_LLM_AGENTS_CONFIG env override", async () => {
    let path = "";
    await loadConfig(makeDeps({
      env: { KAIZEN_LLM_AGENTS_CONFIG: "/etc/agents.json" },
      readFile: async (p) => { path = p; return JSON.stringify({ maxDepth: 5 }); },
    }));
    expect(path).toBe("/etc/agents.json");
  });

  it("merges file over defaults; expands ~ and resolves project dir against cwd", async () => {
    const cfg = await loadConfig(makeDeps({
      readFile: async () => JSON.stringify({ maxDepth: 2, userDir: "~/custom-agents", projectDir: "ai/agents" }),
    }));
    expect(cfg.maxDepth).toBe(2);
    expect(cfg.resolvedUserDir).toBe("/home/u/custom-agents");
    expect(cfg.resolvedProjectDir).toBe("/work/proj/ai/agents");
  });

  it("rejects maxDepth < 1", async () => {
    await expect(loadConfig(makeDeps({
      readFile: async () => JSON.stringify({ maxDepth: 0 }),
    }))).rejects.toThrow(/maxDepth/);
  });

  it("throws on malformed JSON", async () => {
    await expect(loadConfig(makeDeps({
      readFile: async () => "{nope",
    }))).rejects.toThrow(/llm-agents config.*malformed/i);
  });
});
