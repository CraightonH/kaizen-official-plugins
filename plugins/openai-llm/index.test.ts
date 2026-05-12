import { expect, it } from "bun:test";
import plugin from "./index.ts";

it("declares provider service metadata without exposing a local type contract", () => {
  expect(plugin.name).toBe("openai-llm");
  expect(plugin.permissions?.tier).toBe("unscoped");
  expect(plugin.services?.provides).toEqual(["llm:complete"]);
});

it("setup defines and provides llm:complete", async () => {
  const oldConfigPath = process.env.KAIZEN_OPENAI_LLM_CONFIG;
  process.env.KAIZEN_OPENAI_LLM_CONFIG = "/tmp/kaizen-openai-llm-test-missing.json";

  const defined: string[] = [];
  const provided: Record<string, unknown> = {};
  const ctx = {
    log: (_m: string) => {},
    defineService: (name: string) => { defined.push(name); },
    provideService: <T,>(name: string, value: T) => { provided[name] = value; },
  };

  try {
    await plugin.setup(ctx as any);
  } finally {
    if (oldConfigPath === undefined) delete process.env.KAIZEN_OPENAI_LLM_CONFIG;
    else process.env.KAIZEN_OPENAI_LLM_CONFIG = oldConfigPath;
  }

  expect(defined).toEqual(["llm:complete"]);
  expect(provided["llm:complete"]).toMatchObject({
    complete: expect.any(Function),
    listModels: expect.any(Function),
  });
});
