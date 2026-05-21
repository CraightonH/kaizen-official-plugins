import { describe, it, expect } from "bun:test";
import type { ConfigSpec, ConfigStatus, ConfigStoreService, FieldSchema } from "llm-contracts/public";
import { pluginCompletions, keyEqualsValueCompletions, keyOnlyCompletions } from "./slash-completions.ts";

function makeStore(): ConfigStoreService {
  const statuses: ConfigStatus[] = [
    { plugin: "kaizen-config", homePath: "/h", projectPath: "/p", homeExists: true, projectExists: false, resolution: {} },
    { plugin: "openai-llm", homePath: "/h", projectPath: "/p", homeExists: false, projectExists: true, resolution: {} },
  ];
  const specs: Record<string, ConfigSpec<any>> = {
    "kaizen-config": {
      plugin: "kaizen-config",
      defaults: {},
      schema: {
        enabled: { type: "boolean" } as FieldSchema,
        backend: { type: "enum", values: ["env", "keychain"] } as FieldSchema,
        apiKey: { type: "string", secret: true } as FieldSchema,
        url: { type: "string" } as FieldSchema,
      },
    },
  };
  return {
    register: () => {},
    get: () => ({} as any),
    set: async () => {},
    watch: () => () => {},
    list: () => statuses,
    ready: async () => {},
    unset: async () => {},
    getSpec: (p) => specs[p],
  };
}

describe("pluginCompletions", () => {
  it("returns one item per registered plugin with resolution detail", async () => {
    const items = await pluginCompletions(makeStore());
    expect(items.map(i => i.label)).toEqual(["kaizen-config", "openai-llm"]);
    expect(items.find(i => i.label === "kaizen-config")?.detail).toBe("home");
    expect(items.find(i => i.label === "openai-llm")?.detail).toBe("project");
  });
});

describe("keyEqualsValueCompletions", () => {
  it("expands booleans into two items", async () => {
    const items = await keyEqualsValueCompletions(makeStore(), ["kaizen-config"]);
    const labels = items.map(i => i.label);
    expect(labels).toContain("enabled=true");
    expect(labels).toContain("enabled=false");
  });

  it("expands enums into one item per value", async () => {
    const items = await keyEqualsValueCompletions(makeStore(), ["kaizen-config"]);
    const labels = items.map(i => i.label);
    expect(labels).toContain("backend=env");
    expect(labels).toContain("backend=keychain");
  });

  it("appends '· secret' to detail for secret string fields", async () => {
    const items = await keyEqualsValueCompletions(makeStore(), ["kaizen-config"]);
    const apiKey = items.find(i => i.label === "apiKey");
    expect(apiKey?.detail).toContain("secret");
  });

  it("returns [] when plugin is unknown", async () => {
    const items = await keyEqualsValueCompletions(makeStore(), ["nope"]);
    expect(items).toEqual([]);
  });
});

describe("keyOnlyCompletions", () => {
  it("returns one item per top-level key with no '=' suffix", async () => {
    const items = await keyOnlyCompletions(makeStore(), ["kaizen-config"]);
    const labels = items.map(i => i.label);
    expect(labels.sort()).toEqual(["apiKey", "backend", "enabled", "url"].sort());
    for (const it of items) expect(it.insertText.includes("=")).toBe(false);
  });
});
