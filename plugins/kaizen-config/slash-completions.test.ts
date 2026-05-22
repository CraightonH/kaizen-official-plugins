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

  it("appends a trailing space to insertText so the next slot fires", async () => {
    const items = await pluginCompletions(makeStore());
    for (const it of items) expect(it.insertText.endsWith(" ")).toBe(true);
  });
});

describe("keyEqualsValueCompletions", () => {
  function storeWith(
    snapshot: Record<string, unknown>,
    resolution: Record<string, "default" | "home" | "project" | "env">,
  ): ConfigStoreService {
    const base = makeStore();
    return {
      ...base,
      get: () => snapshot as any,
      list: () => [
        {
          plugin: "kaizen-config",
          homePath: "/h",
          projectPath: "/p",
          homeExists: true,
          projectExists: false,
          resolution,
        },
      ],
    };
  }

  it("returns [] when plugin is unknown", async () => {
    const items = await keyEqualsValueCompletions(makeStore(), ["nope"], "");
    expect(items).toEqual([]);
  });

  it("field tier (empty query): one row per field, each with ✓ value in detail", async () => {
    const store = storeWith(
      { enabled: true, backend: "keychain", apiKey: "swordfish", url: "https://x" },
      { enabled: "home", backend: "home", apiKey: "home", url: "home" },
    );
    const items = await keyEqualsValueCompletions(store, ["kaizen-config"], "");
    const labels = items.map((i) => i.label).sort();
    expect(labels).toEqual(["apiKey", "backend", "enabled", "url"]);
    expect(items.find((i) => i.label === "enabled")!.detail)
      .toBe("✓ true · home  boolean");
    expect(items.find((i) => i.label === "apiKey")!.detail)
      .toBe("✓ *** · home  string · secret");
    expect(items.find((i) => i.label === "url")!.insertText).toBe("url=https://x ");
    expect(items.find((i) => i.label === "enabled")!.insertText).toBe("enabled=");
  });

  it("field tier: unset values render (unset) with no ✓ and key= insertText", async () => {
    const store = storeWith({}, {});
    const items = await keyEqualsValueCompletions(store, ["kaizen-config"], "");
    expect(items.find((i) => i.label === "url")!.detail).toBe("(unset)  string");
    expect(items.find((i) => i.label === "url")!.insertText).toBe("url=");
  });

  it("field tier: env-sourced value shows · env in detail and suppresses pre-fill", async () => {
    const store = storeWith({ url: "https://env" }, { url: "env" });
    const items = await keyEqualsValueCompletions(store, ["kaizen-config"], "");
    expect(items.find((i) => i.label === "url")!.detail)
      .toBe("✓ https://env · env  string");
    expect(items.find((i) => i.label === "url")!.insertText).toBe("url=");
  });

  it("value tier (query has '='): rows for the matching field only", async () => {
    const store = storeWith(
      { enabled: true, backend: "keychain" },
      { enabled: "home", backend: "home" },
    );
    const items = await keyEqualsValueCompletions(store, ["kaizen-config"], "enabled=");
    expect(items.map((i) => i.label)).toEqual(["✓ true", "  false"]);
    expect(items[0]!.insertText).toBe("enabled=true ");
  });

  it("value tier: enum values, ✓ on current", async () => {
    const store = storeWith({ backend: "keychain" }, { backend: "home" });
    const items = await keyEqualsValueCompletions(store, ["kaizen-config"], "backend=");
    expect(items.map((i) => i.label)).toEqual(["  env", "✓ keychain"]);
  });

  it("value tier: filters by post-= text", async () => {
    const store = storeWith({ backend: "env" }, { backend: "home" });
    const items = await keyEqualsValueCompletions(store, ["kaizen-config"], "backend=k");
    expect(items.map((i) => i.label)).toEqual(["  keychain"]);
  });

  it("value tier: free-form field returns []", async () => {
    const store = storeWith({ url: "https://x" }, { url: "home" });
    const items = await keyEqualsValueCompletions(store, ["kaizen-config"], "url=");
    expect(items).toEqual([]);
  });

  it("value tier: unknown key returns []", async () => {
    const store = storeWith({}, {});
    const items = await keyEqualsValueCompletions(store, ["kaizen-config"], "nopeKey=");
    expect(items).toEqual([]);
  });
});

describe("keyOnlyCompletions", () => {
  function storeWith(
    snapshot: Record<string, unknown>,
    resolution: Record<string, "default" | "home" | "project" | "env">,
  ): ConfigStoreService {
    const base = makeStore();
    return {
      ...base,
      get: () => snapshot as any,
      list: () => [
        {
          plugin: "kaizen-config",
          homePath: "/h",
          projectPath: "/p",
          homeExists: true,
          projectExists: false,
          resolution,
        },
      ],
    };
  }

  it("returns one row per field with insertText `key ` (trailing space, no `=`)", async () => {
    const store = storeWith({ url: "https://x" }, { url: "home" });
    const items = await keyOnlyCompletions(store, ["kaizen-config"]);
    expect(items.map((i) => i.label).sort()).toEqual(["apiKey", "backend", "enabled", "url"]);
    const url = items.find((i) => i.label === "url")!;
    expect(url.insertText).toBe("url ");
    expect(url.insertText.includes("=")).toBe(false);
  });

  it("detail uses the same ✓ value · source  type convention as the field tier", async () => {
    const store = storeWith({ url: "https://x" }, { url: "home" });
    const items = await keyOnlyCompletions(store, ["kaizen-config"]);
    expect(items.find((i) => i.label === "url")!.detail).toBe("✓ https://x · home  string");
  });

  it("returns [] when plugin is unknown", async () => {
    const items = await keyOnlyCompletions(makeStore(), ["nope"]);
    expect(items).toEqual([]);
  });
});
