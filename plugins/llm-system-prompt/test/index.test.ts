import { describe, expect, it } from "bun:test";
import plugin from "../index.ts";
import type {
  SystemPromptSection,
  SystemPromptService,
  RegisteredSection,
} from "../public";

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

describe("public.d.ts type surface", () => {
  it("exports SystemPromptSection / SystemPromptService / RegisteredSection", () => {
    const _section: SystemPromptSection = {
      id: "x",
      priority: 100,
      render: () => "",
    };
    const _h: RegisteredSection = { unregister: () => {}, bumpGeneration: () => {} };
    const _svc = null as unknown as SystemPromptService;
    expect(_section.id).toBe("x");
    expect(_h).toBeTruthy();
    expect(_svc).toBeNull();
  });
});
