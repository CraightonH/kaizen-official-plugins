// plugins/kaizen-config/test/slash.test.ts
import { describe, it, expect } from "bun:test";
import { registerSlashCommands, type SlashRegistryLike, type SlashDeps } from "../slash.ts";
import type { ConfigStoreService } from "llm-contracts/public";

function makeRegistry() {
  const registered: { manifest: any; handler: any }[] = [];
  const reg: SlashRegistryLike = {
    register(manifest, handler) {
      registered.push({ manifest, handler });
      return () => {
        const i = registered.findIndex((r) => r.manifest.name === manifest.name);
        if (i >= 0) registered.splice(i, 1);
      };
    },
  };
  return { reg, registered };
}

function makeStore(over: Partial<ConfigStoreService> = {}): ConfigStoreService {
  return {
    register: () => {},
    get: (p: string) => ({ x: 1, plugin: p }),
    set: async () => {},
    unset: async () => {},
    watch: () => () => {},
    list: () => [{
      plugin: "openai-llm",
      homePath: "/h/config.json",
      projectPath: "/p/config.json",
      homeExists: true,
      projectExists: false,
      resolution: { baseUrl: "home", apiKey: "env" },
    }],
    ready: async () => {},
    getSpec: () => undefined,
    ...over,
  } as ConfigStoreService;
}

function makeDeps(over: Partial<SlashDeps> = {}): SlashDeps {
  return {
    store: makeStore(),
    homePath: "/h/config.json",
    projectPath: "/p/config.json",
    harnessKey: "default",
    editor: "vi",
    log: () => {},
    spawnEditor: () => Promise.resolve(0),
    registry: {
      schemes: () => [],
      readOnlySchemes: () => [],
      has: () => false,
      register: () => () => {},
      resolve: async () => "",
      store: async () => ({ $ref: "" }),
      delete: async () => {},
    } as any,
    defaultSecretBackend: () => undefined,
    ...over,
  };
}

const call = async (handler: any, args = "") => {
  const lines: string[] = [];
  await handler({ args, print: async (t: string) => { lines.push(t); } });
  return lines.join("\n");
};

describe("/config list", () => {
  it("registers and prints the list", async () => {
    const { reg, registered } = makeRegistry();
    registerSlashCommands(reg, makeDeps());
    const cmd = registered.find((r) => r.manifest.name === "config:list");
    expect(cmd).toBeDefined();
    const out = await call(cmd!.handler);
    expect(out).toMatch(/openai-llm/);
  });
});

describe("/config get", () => {
  it("prints merged value for a plugin", async () => {
    const { reg, registered } = makeRegistry();
    registerSlashCommands(reg, makeDeps());
    const cmd = registered.find((r) => r.manifest.name === "config:get")!;
    const out = await call(cmd.handler, "openai-llm");
    expect(out).toMatch(/"x":\s*1/);
  });
});

describe("/config set", () => {
  it("parses scalar value and calls store.set with home scope by default", async () => {
    const calls: any[] = [];
    const { reg, registered } = makeRegistry();
    registerSlashCommands(reg, makeDeps({
      store: makeStore({ set: async (p, v, s) => { calls.push({ p, v, s }); } }),
    }));
    const cmd = registered.find((r) => r.manifest.name === "config:set")!;
    await call(cmd.handler, "openai-llm defaultModel=gpt-4");
    expect(calls).toEqual([{ p: "openai-llm", v: { defaultModel: "gpt-4" }, s: "home" }]);
  });

  it("uses project scope with --project flag", async () => {
    const calls: any[] = [];
    const { reg, registered } = makeRegistry();
    registerSlashCommands(reg, makeDeps({
      store: makeStore({ set: async (p, v, s) => { calls.push({ p, v, s }); } }),
    }));
    const cmd = registered.find((r) => r.manifest.name === "config:set")!;
    await call(cmd.handler, "openai-llm defaultModel=gpt-4 --project");
    expect(calls[0].s).toBe("project");
  });

  it("parses number-like values as numbers", async () => {
    const calls: any[] = [];
    const { reg, registered } = makeRegistry();
    registerSlashCommands(reg, makeDeps({
      store: makeStore({ set: async (p, v, s) => { calls.push({ p, v, s }); } }),
    }));
    const cmd = registered.find((r) => r.manifest.name === "config:set")!;
    await call(cmd.handler, "openai-llm defaultTemperature=0.5");
    expect(calls[0].v).toEqual({ defaultTemperature: 0.5 });
  });

  it("supports dotted key path (retry.maxAttempts=5)", async () => {
    const calls: any[] = [];
    const { reg, registered } = makeRegistry();
    registerSlashCommands(reg, makeDeps({
      store: makeStore({ set: async (p, v) => { calls.push({ p, v }); } }),
    }));
    const cmd = registered.find((r) => r.manifest.name === "config:set")!;
    await call(cmd.handler, "openai-llm retry.maxAttempts=5");
    expect(calls[0].v).toEqual({ retry: { maxAttempts: 5 } });
  });
});

describe("/config:get — secret redaction", () => {
  it("redacts secret-marked fields by default", async () => {
    const { reg, registered } = makeRegistry();
    const deps = makeDeps({
      store: makeStore({
        get: (_p: string) => ({ apiKey: "tvly-abc", model: "gpt-4" }),
        list: () => [{
          plugin: "x",
          homePath: "/h",
          projectPath: "/p",
          homeExists: true,
          projectExists: false,
          resolution: { apiKey: "secret:keychain", model: "home" },
        }],
        getSpec: (_p: string) => ({
          plugin: "x",
          defaults: { apiKey: "", model: "" },
          schema: { apiKey: { type: "string", secret: true }, model: { type: "string" } },
        }),
      } as any),
    });
    registerSlashCommands(reg, deps);
    const handler = registered.find((r) => r.manifest.name === "config:get")!.handler;
    const out = await call(handler, "x");
    expect(out).toContain("<redacted");
    expect(out).not.toContain("tvly-abc");
  });

  it("reveals plaintext when --reveal is passed", async () => {
    const { reg, registered } = makeRegistry();
    const deps = makeDeps({
      store: makeStore({
        get: () => ({ apiKey: "tvly-abc" }),
        getSpec: (_p: string) => ({
          plugin: "x",
          defaults: { apiKey: "" },
          schema: { apiKey: { type: "string", secret: true } },
        }),
      } as any),
    });
    registerSlashCommands(reg, deps);
    const handler = registered.find((r) => r.manifest.name === "config:get")!.handler;
    const out = await call(handler, "x --reveal");
    expect(out).toContain("tvly-abc");
  });
});

describe("/config edit", () => {
  it("invokes the configured editor on the home path by default", async () => {
    const invocations: any[] = [];
    const { reg, registered } = makeRegistry();
    registerSlashCommands(reg, makeDeps({
      spawnEditor: async (editor, path) => { invocations.push({ editor, path }); return 0; },
    }));
    const cmd = registered.find((r) => r.manifest.name === "config:edit")!;
    await call(cmd.handler);
    expect(invocations).toEqual([{ editor: "vi", path: "/h/config.json" }]);
  });

  it("opens the project path with --project", async () => {
    const invocations: any[] = [];
    const { reg, registered } = makeRegistry();
    registerSlashCommands(reg, makeDeps({
      spawnEditor: async (editor, path) => { invocations.push({ editor, path }); return 0; },
    }));
    const cmd = registered.find((r) => r.manifest.name === "config:edit")!;
    await call(cmd.handler, "--project");
    expect(invocations[0].path).toBe("/p/config.json");
  });
});

describe("/config:unset", () => {
  it("registers and calls store.unset with the given key + scope", async () => {
    const { reg, registered } = makeRegistry();
    const calls: { plugin: string; key: string; scope?: string }[] = [];
    const deps = makeDeps({
      store: makeStore({
        unset: async (plugin: string, key: string, scope?: string) => { calls.push({ plugin, key, scope }); },
      } as any),
    });
    registerSlashCommands(reg, deps);
    const handler = registered.find((r) => r.manifest.name === "config:unset")!.handler;
    const out = await call(handler, "x apiKey --project");
    expect(calls).toEqual([{ plugin: "x", key: "apiKey", scope: "project" }]);
    expect(out).toMatch(/Unset x\.apiKey \(project\)/);
  });

  it("usage on bad args", async () => {
    const { reg, registered } = makeRegistry();
    registerSlashCommands(reg, makeDeps());
    const handler = registered.find((r) => r.manifest.name === "config:unset")!.handler;
    const out = await call(handler, "");
    expect(out).toMatch(/Usage:/);
  });
});

describe("/config:set — completion callback threads query through", () => {
  function makeStoreWithSchema(): ConfigStoreService {
    return makeStore({
      list: () => [
        {
          plugin: "kaizen-config",
          homePath: "/h",
          projectPath: "/p",
          homeExists: true,
          projectExists: false,
          resolution: {},
        },
      ],
      getSpec: (_p: string) => ({
        plugin: "kaizen-config",
        defaults: {},
        schema: {
          enabled: { type: "boolean" },
          backend: { type: "enum", values: ["env", "keychain"] },
          apiKey: { type: "string", secret: true },
          url: { type: "string" },
        },
      }),
    });
  }

  it("threads query into keyEqualsValueCompletions — field tier vs value tier", async () => {
    const captured: { arg?: { complete?: (prev: string[], query: string) => Promise<any> } } = {};
    const reg: SlashRegistryLike = {
      register(manifest: any, _handler: any) {
        if (manifest.name === "config:set") {
          captured.arg = manifest.arguments?.[1];
        }
        return () => {};
      },
    };
    registerSlashCommands(reg, makeDeps({ store: makeStoreWithSchema() }));

    expect(captured.arg?.complete).toBeDefined();
    const rowsField = await captured.arg!.complete!(["kaizen-config"], "");
    const rowsValue = await captured.arg!.complete!(["kaizen-config"], "enabled=");
    // Field tier returns all schema keys; value tier returns 2 booleans
    expect(rowsField.length).toBeGreaterThan(rowsValue.length);
    expect(rowsValue.every((r: any) => r.label.includes("true") || r.label.includes("false"))).toBe(true);
  });
});

describe("/config:list — resolution + backends footer", () => {
  it("prints resolution column and registered backends in footer", async () => {
    const { reg, registered } = makeRegistry();
    const fakeRegistry = {
      schemes: () => ["env", "keychain"],
      readOnlySchemes: () => ["env"],
      has: (s: string) => ["env", "keychain"].includes(s),
      register: () => () => {},
      resolve: async () => "",
      store: async () => ({ $ref: "" }),
      delete: async () => {},
    };
    registerSlashCommands(reg, makeDeps({
      store: makeStore({
        list: () => [{
          plugin: "x",
          homePath: "/h",
          projectPath: "/p",
          homeExists: true,
          projectExists: false,
          resolution: { apiKey: "secret:keychain", model: "home" },
        }],
        get: (_p: string) => ({}),
      }),
      registry: fakeRegistry as any,
      defaultSecretBackend: () => "keychain",
    }));
    const handler = registered.find((r) => r.manifest.name === "config:list")!.handler;
    const out = await call(handler);
    expect(out).toContain("apiKey: secret:keychain");
    expect(out).toContain("Backends:");
    expect(out).toContain("env       (read-only, built-in)");
    expect(out).toContain("keychain  (default)");
  });
});
