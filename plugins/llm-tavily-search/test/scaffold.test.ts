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
  } as any;
}

describe("llm-tavily-search plugin", () => {
  it("metadata", () => {
    expect(plugin.name).toBe("llm-tavily-search");
    expect(plugin.apiVersion).toBe("3.0.0");
    expect(plugin.services?.consumes).toContain("tools:registry");
  });

  it("registers web_search at setup", async () => {
    const registry = makeRegistry();
    const ctx = makeCtx(registry);
    await plugin.setup!(ctx);
    expect(registry.registered).toEqual(["web_search"]);
  });

  it("teardown unregisters", async () => {
    const registry = makeRegistry();
    const ctx = makeCtx(registry);
    const result = await plugin.setup!(ctx) as { teardown: () => Promise<void> };
    await result.teardown();
    expect(registry.registered).toEqual([]);
  });

  it("throws if tools:registry is unavailable", async () => {
    const ctx = { log: () => {}, useService: () => undefined } as any;
    await expect(plugin.setup!(ctx)).rejects.toThrow(/tools:registry/);
  });
});
