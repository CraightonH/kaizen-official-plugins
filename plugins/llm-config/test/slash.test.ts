// plugins/llm-config/test/slash.test.ts
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
    watch: () => () => {},
    list: () => [{
      plugin: "openai-llm",
      homePath: "/h/config.json",
      projectPath: "/p/config.json",
      homeExists: true,
      projectExists: false,
      resolution: { baseUrl: "home", apiKey: "env" },
    }],
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
