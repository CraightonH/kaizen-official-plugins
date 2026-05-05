import { describe, expect, it, mock } from "bun:test";
import plugin from "../index.ts";

function makeFakeCtx() {
  const provided: Record<string, unknown> = {};
  const registeredSections: any[] = [];
  const subs = new Map<string, (p: unknown) => unknown>();
  const fakePromptSystem = {
    register: (s: any) => {
      registeredSections.push(s);
      return {
        unregister: () => {},
        bumpGeneration: () => { (registeredSections as any).bumps = ((registeredSections as any).bumps ?? 0) + 1; },
      };
    },
    assemble: async () => "",
    list: () => registeredSections.map((s) => ({ id: s.id, priority: s.priority })),
    generation: () => 0,
  };
  const fakeToolsRegistry = {
    register: () => () => {},
    registerWith: () => () => {},
    list: () => [],
    listRegistrations: () => [],
    invoke: async () => null,
  };
  return {
    cwd: process.cwd(),
    env: {},
    log: () => {},
    defineService: (_n: string, _o: unknown) => {},
    provideService: <T,>(n: string, v: T) => { provided[n] = v; },
    consumeService: () => {},
    useService: (n: string) => {
      if (n === "prompt:system") return fakePromptSystem;
      if (n === "tools:registry") return fakeToolsRegistry;
      return undefined;
    },
    defineEvent: () => {},
    emit: async () => {},
    on: (event: string, h: (p: unknown) => unknown) => {
      subs.set(event, h);
      return () => subs.delete(event);
    },
    config: {},
    provided, registeredSections, subs,
  };
}

describe("index — prompt:system integration", () => {
  it("registers an api section at priority 100 when prompt:system is available", async () => {
    const ctx = makeFakeCtx();
    await plugin.setup!(ctx as any);
    expect(ctx.registeredSections.length).toBe(1);
    expect(ctx.registeredSections[0]!.id).toBe("llm-codemode-dispatch:api");
    expect(ctx.registeredSections[0]!.priority).toBe(100);
  });

  it("when prompt:system is registered, prepareRequest returns no systemPromptAppend", async () => {
    const ctx = makeFakeCtx();
    await plugin.setup!(ctx as any);
    const strategy = ctx.provided["tool-dispatch:strategy"] as any;
    const r = await strategy.prepareRequest({ availableTools: [] });
    expect(r.systemPromptAppend).toBeUndefined();
    expect(r.tools).toBeUndefined();
  });
});
