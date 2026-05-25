// plugins/llm-tavily-search/test/scaffold.test.ts
import { describe, it, expect, mock } from "bun:test";
import plugin from "../index.ts";
import { DEFAULT_CONFIG } from "../config.ts";

function makeRegistry() {
  const registered: string[] = [];
  return {
    registered,
    register: mock((schema: any, _handler: any) => {
      registered.push(schema.name);
      return () => {
        const i = registered.indexOf(schema.name);
        if (i >= 0) registered.splice(i, 1);
      };
    }),
    list: mock(() => []),
    invoke: mock(async () => undefined),
  };
}

function makeConfigStore() {
  const registrations: Array<{ plugin: string }> = [];
  return {
    registrations,
    register: mock((spec: { plugin: string }) => { registrations.push(spec); }),
    get: mock(<T,>(_plugin: string): T => ({ ...DEFAULT_CONFIG }) as unknown as T),
    set: mock(async () => {}),
    watch: mock(() => () => {}),
    list: mock(() => []),
    ready: mock(async () => {}),
  };
}

function makeCtx(registry: any, configStore: any = makeConfigStore()) {
  const consumed = new Set<string>();
  return {
    consumed,
    log: mock(() => {}),
    useService: mock((name: string) => {
      if (name === "tools:registry") return registry;
      if (name === "config:store") return configStore;
      return undefined;
    }),
    defineEvent: mock(() => {}),
    on: mock(() => {}),
    emit: mock(async () => []),
    defineService: mock(() => {}),
    provideService: mock(() => {}),
    consumeService: mock((name: string) => { consumed.add(name); }),
    secrets: { get: async () => undefined },
  } as any;
}

describe("llm-tavily-search plugin", () => {
  it("metadata", () => {
    expect(plugin.name).toBe("llm-tavily-search");
    expect(plugin.apiVersion).toBe("3.0.0");
    expect(plugin.permissions?.tier).toBe("trusted");
    expect(plugin.services?.consumes).toContain("tools:registry");
    expect(plugin.services?.consumes).toContain("config:store");
  });

  it("registers web_search at setup", async () => {
    const registry = makeRegistry();
    const ctx = makeCtx(registry);
    await plugin.setup!(ctx);
    expect(registry.registered).toEqual(["web_search"]);
    await plugin.stop?.(ctx);
  });

  it("registers config schema with config:store", async () => {
    const registry = makeRegistry();
    const configStore = makeConfigStore();
    const ctx = makeCtx(registry, configStore);
    await plugin.setup!(ctx);
    expect(configStore.registrations).toHaveLength(1);
    expect(configStore.registrations[0].plugin).toBe("llm-tavily-search");
    await plugin.stop?.(ctx);
  });

  it("stop() unregisters", async () => {
    const registry = makeRegistry();
    const ctx = makeCtx(registry);
    await plugin.setup!(ctx);
    await plugin.stop!(ctx);
    expect(registry.registered).toEqual([]);
  });

  it("stop() is idempotent", async () => {
    const registry = makeRegistry();
    const ctx = makeCtx(registry);
    await plugin.setup!(ctx);
    await plugin.stop!(ctx);
    // Second stop must not throw or double-unregister.
    await expect(plugin.stop!(ctx)).resolves.toBeUndefined();
    expect(registry.registered).toEqual([]);
  });

  it("throws if tools:registry is unavailable", async () => {
    const ctx = {
      log: () => {},
      useService: () => undefined,
      consumeService: () => {},
    } as any;
    await expect(plugin.setup!(ctx)).rejects.toThrow(/tools:registry/);
  });
});
