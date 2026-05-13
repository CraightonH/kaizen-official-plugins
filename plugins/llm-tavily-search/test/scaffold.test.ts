// plugins/llm-tavily-search/test/scaffold.test.ts
import { describe, it, expect, mock } from "bun:test";
import plugin from "../index.ts";

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

function makeCtx(registry: any) {
  return {
    log: mock(() => {}),
    useService: mock((name: string) => name === "tools:registry" ? registry : undefined),
    defineEvent: mock(() => {}),
    on: mock(() => {}),
    emit: mock(async () => []),
    defineService: mock(() => {}),
    provideService: mock(() => {}),
    consumeService: mock(() => {}),
    secrets: { get: async () => undefined },
  } as any;
}

describe("llm-tavily-search plugin", () => {
  it("metadata", () => {
    expect(plugin.name).toBe("llm-tavily-search");
    expect(plugin.apiVersion).toBe("3.0.0");
    expect(plugin.permissions?.tier).toBe("trusted");
    expect(plugin.services?.consumes).toContain("tools:registry");
  });

  it("registers web_search at setup", async () => {
    const registry = makeRegistry();
    const ctx = makeCtx(registry);
    await plugin.setup!(ctx);
    expect(registry.registered).toEqual(["web_search"]);
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
    const ctx = { log: () => {}, useService: () => undefined } as any;
    await expect(plugin.setup!(ctx)).rejects.toThrow(/tools:registry/);
  });
});
