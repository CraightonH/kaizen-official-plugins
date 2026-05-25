import { expect, it } from "bun:test";
import plugin from "./index.ts";
import { DEFAULT_CONFIG, CONFIG_SCHEMA } from "./config.ts";
import type { OpenAILLMConfig } from "./public.d.ts";

it("declares provider service metadata without exposing a local type contract", () => {
  expect(plugin.name).toBe("openai-llm");
  expect(plugin.permissions?.tier).toBe("unscoped");
  expect(plugin.services?.provides).toEqual(["llm:complete"]);
  expect(plugin.services?.consumes).toEqual(["events:vocabulary", "config:store"]);
});

it("declares apiKey as a secret field and omits envVars from the spec", () => {
  // INTEGRATION.md cites this plugin as the secret-field example.
  // apiKey must be `secret: true` so config:store stores the plaintext via
  // secrets:registry and only the $ref pointer hits disk.
  expect(CONFIG_SCHEMA.apiKey).toMatchObject({ type: "string", secret: true });
  // `min` is intentionally omitted on apiKey — see config.ts for rationale.
  expect((CONFIG_SCHEMA.apiKey as { min?: number }).min).toBeUndefined();
});

it("setup registers config (no envVars), awaits ready, gets value, provides llm:complete", async () => {
  const consumed: string[] = [];
  const provided: Record<string, unknown> = {};
  const registered: Array<{ plugin: string; envVars?: unknown; schema?: any }> = [];
  let readyAwaited = false;
  let getCalledAfterReady = false;

  const configStore = {
    register: (spec: { plugin: string; envVars?: unknown; schema?: any }) => {
      registered.push(spec);
    },
    ready: async () => {
      readyAwaited = true;
    },
    get: <T,>(_plugin: string): T => {
      // Mirror the real store: get() after ready() yields plaintext.
      if (readyAwaited) getCalledAfterReady = true;
      return ({
        ...DEFAULT_CONFIG,
        retry: { ...DEFAULT_CONFIG.retry },
        extraHeaders: { ...DEFAULT_CONFIG.extraHeaders },
      }) as unknown as T;
    },
    set: async () => {},
    watch: () => () => {},
    list: () => [],
  };

  const ctx = {
    log: (_m: string) => {},
    defineService: (_name: string) => {},
    consumeService: (name: string) => { consumed.push(name); },
    useService: <T,>(name: string): T => {
      if (name === "config:store") return configStore as unknown as T;
      throw new Error(`unexpected useService(${name})`);
    },
    provideService: <T,>(name: string, value: T) => { provided[name] = value; },
  };

  await plugin.setup(ctx as any);

  // The migration drops the redundant ctx.consumeService() calls — the
  // declarative services.consumes in the manifest is the contract.
  expect(consumed).toEqual([]);
  expect(registered).toHaveLength(1);
  expect(registered[0]?.plugin).toBe("openai-llm");
  // envVars must NOT be present on the spec.
  expect(registered[0]?.envVars).toBeUndefined();
  // apiKey must arrive at the store as a secret-flagged field.
  expect(registered[0]?.schema?.apiKey).toMatchObject({ type: "string", secret: true });
  // ready() must be awaited before get() (secret-ref resolution).
  expect(readyAwaited).toBe(true);
  expect(getCalledAfterReady).toBe(true);
  expect(provided["llm:complete"]).toMatchObject({
    complete: expect.any(Function),
    listModels: expect.any(Function),
  });
});

it("setup falls back to defaults when config:store is unavailable", async () => {
  const provided: Record<string, unknown> = {};
  const logs: string[] = [];

  const ctx = {
    log: (m: string) => { logs.push(m); },
    defineService: (_name: string) => {},
    consumeService: (_name: string) => {},
    useService: <T,>(_name: string): T | undefined => undefined,
    provideService: <T,>(name: string, value: T) => { provided[name] = value; },
  };

  await plugin.setup(ctx as any);

  expect(provided["llm:complete"]).toMatchObject({
    complete: expect.any(Function),
    listModels: expect.any(Function),
  });
  expect(logs.some((m) => m.includes("config:store unavailable"))).toBe(true);
});

it("setup logs and falls back to defaults when register() throws", async () => {
  const provided: Record<string, unknown> = {};
  const logs: string[] = [];

  const configStore = {
    register: () => { throw new Error("boom"); },
    ready: async () => {},
    get: <T,>(_plugin: string): T => ({} as T),
    set: async () => {},
    watch: () => () => {},
    list: () => [],
  };

  const ctx = {
    log: (m: string) => { logs.push(m); },
    defineService: (_name: string) => {},
    consumeService: (_name: string) => {},
    useService: <T,>(name: string): T => {
      if (name === "config:store") return configStore as unknown as T;
      return undefined as unknown as T;
    },
    provideService: <T,>(name: string, value: T) => { provided[name] = value; },
  };

  await plugin.setup(ctx as any);

  expect(provided["llm:complete"]).toBeDefined();
  expect(logs.some((m) => m.includes("register failed") && m.includes("boom"))).toBe(true);
});

// Touch OpenAILLMConfig so the import isn't tree-shaken away in tsc --noEmit.
const _typeProbe: OpenAILLMConfig | undefined = undefined;
void _typeProbe;
