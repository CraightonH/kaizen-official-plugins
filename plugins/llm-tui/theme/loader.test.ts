import { describe, it, expect, mock } from "bun:test";
import { loadTheme, DEFAULT_THEME, type ThemeDeps } from "./loader.ts";

function makeDeps(overrides: Partial<ThemeDeps> = {}): ThemeDeps {
  return {
    home: "/home/u",
    env: {},
    readFile: async () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); },
    log: mock(() => {}),
    harnessDefaults: undefined,
    ...overrides,
  };
}

describe("loadTheme", () => {
  it("returns DEFAULT_THEME when config file is absent (silent)", async () => {
    const log = mock(() => {});
    const t = await loadTheme(makeDeps({ log }));
    expect(t).toEqual(DEFAULT_THEME);
    expect(log).not.toHaveBeenCalled();
  });

  it("merges file values over defaults", async () => {
    const t = await loadTheme(makeDeps({
      readFile: async () => JSON.stringify({ theme: { promptLabel: "kaizen", promptColor: "#7aa2f7" } }),
    }));
    expect(t.promptLabel).toBe("kaizen");
    expect(t.promptColor).toBe("#7aa2f7");
    expect(t.outputColor).toBe(DEFAULT_THEME.outputColor);
  });

  it("user file wins over harnessDefaults; harnessDefaults wins over DEFAULT_THEME", async () => {
    const t = await loadTheme(makeDeps({
      harnessDefaults: { promptLabel: "harness", busyColor: "blue" },
      readFile: async () => JSON.stringify({ theme: { promptLabel: "user" } }),
    }));
    expect(t.promptLabel).toBe("user");
    expect(t.busyColor).toBe("blue");
    expect(t.outputColor).toBe(DEFAULT_THEME.outputColor);
  });

  it("malformed JSON: log a notice, fall back to defaults", async () => {
    const log = mock(() => {});
    const t = await loadTheme(makeDeps({
      readFile: async () => "{not-json",
      log,
    }));
    expect(t).toEqual(DEFAULT_THEME);
    expect(log).toHaveBeenCalled();
    const arg = (log.mock.calls[0]?.[0] ?? "") as string;
    expect(arg).toContain("malformed");
  });

  it("invalid colour values are dropped; valid ones kept", async () => {
    const t = await loadTheme(makeDeps({
      readFile: async () => JSON.stringify({
        theme: { promptColor: "#7aa2f7", outputColor: 123 as any, busyColor: "magenta" },
      }),
    }));
    expect(t.promptColor).toBe("#7aa2f7");
    expect(t.outputColor).toBe(DEFAULT_THEME.outputColor); // dropped
    expect(t.busyColor).toBe("magenta");
  });

  it("honors KAIZEN_LLM_TUI_CONFIG env override", async () => {
    let readPath = "";
    await loadTheme(makeDeps({
      env: { KAIZEN_LLM_TUI_CONFIG: "/etc/llm-tui.json" },
      readFile: async (p: string) => { readPath = p; return JSON.stringify({}); },
    }));
    expect(readPath).toBe("/etc/llm-tui.json");
  });
});
