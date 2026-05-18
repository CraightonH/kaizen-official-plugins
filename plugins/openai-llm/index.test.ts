import { expect, it } from "bun:test";
import plugin from "./index.ts";
import { DEFAULT_CONFIG } from "./defaults.ts";
import type { OpenAILLMConfig } from "./public.d.ts";

it("declares provider service metadata without exposing a local type contract", () => {
  expect(plugin.name).toBe("openai-llm");
  expect(plugin.permissions?.tier).toBe("unscoped");
  expect(plugin.services?.provides).toEqual(["llm:complete"]);
  expect(plugin.services?.consumes).toEqual(["events:vocabulary", "config:store"]);
});

it("setup consumes events:vocabulary + config:store, registers config, provides llm:complete", async () => {
  const defined: string[] = [];
  const consumed: string[] = [];
  const provided: Record<string, unknown> = {};
  const registered: Array<{ plugin: string }> = [];

  const configStore = {
    register: (spec: { plugin: string }) => { registered.push(spec); },
    get: <T,>(_plugin: string): T => ({
      ...DEFAULT_CONFIG,
      retry: { ...DEFAULT_CONFIG.retry },
      extraHeaders: { ...DEFAULT_CONFIG.extraHeaders },
    }) as unknown as T,
    set: async () => {},
    watch: () => () => {},
    list: () => [],
  };

  const ctx = {
    log: (_m: string) => {},
    defineService: (name: string) => { defined.push(name); },
    consumeService: (name: string) => { consumed.push(name); },
    useService: <T,>(name: string): T => {
      if (name === "config:store") return configStore as unknown as T;
      throw new Error(`unexpected useService(${name})`);
    },
    provideService: <T,>(name: string, value: T) => { provided[name] = value; },
  };

  await plugin.setup(ctx as any);

  expect(consumed).toEqual(["events:vocabulary", "config:store"]);
  expect(defined).toEqual([]);
  expect(registered).toHaveLength(1);
  expect(registered[0]?.plugin).toBe("openai-llm");
  expect(provided["llm:complete"]).toMatchObject({
    complete: expect.any(Function),
    listModels: expect.any(Function),
  });
});
