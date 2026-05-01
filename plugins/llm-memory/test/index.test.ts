import { describe, it, expect } from "bun:test";
import plugin from "../index.ts";

describe("llm-memory metadata", () => {
  it("name + apiVersion", () => {
    expect(plugin.name).toBe("llm-memory");
    expect(plugin.apiVersion).toBe("3.0.0");
  });
  it("declares unscoped tier", () => {
    expect(plugin.permissions?.tier).toBe("unscoped");
  });
  it("provides memory:store", () => {
    expect(plugin.services?.provides).toContain("memory:store");
  });
});

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock } from "bun:test";

function makeCtx(env: Record<string, string | undefined> = {}) {
  const services: Record<string, unknown> = {};
  const handlers: Record<string, Function[]> = {};
  return {
    log: mock(() => {}),
    defineService: mock(() => {}),
    provideService: mock((name: string, impl: unknown) => { services[name] = impl; }),
    consumeService: mock(() => {}),
    useService: mock((name: string) => services[name]),
    on: mock((evt: string, h: Function) => { (handlers[evt] ??= []).push(h); }),
    emit: mock(async () => []),
    defineEvent: mock(() => {}),
    secrets: { get: mock(async () => undefined), refresh: mock(async () => undefined) },
    services,
    handlers,
  } as any;
}

describe("llm-memory setup wiring", () => {
  it("provides memory:store and subscribes llm:before-call", async () => {
    const home = mkdtempSync(join(tmpdir(), "llm-memory-home-"));
    const orig = process.env.HOME;
    process.env.HOME = home;
    try {
      const ctx = makeCtx();
      await plugin.setup(ctx);
      expect(ctx.services["memory:store"]).toBeTruthy();
      expect(ctx.handlers["llm:before-call"]?.length).toBe(1);
    } finally {
      if (orig !== undefined) process.env.HOME = orig;
    }
  });
  it("does not subscribe turn:end when autoExtract default (false)", async () => {
    const home = mkdtempSync(join(tmpdir(), "llm-memory-home-"));
    const orig = process.env.HOME;
    process.env.HOME = home;
    try {
      const ctx = makeCtx();
      await plugin.setup(ctx);
      expect(ctx.handlers["turn:end"]).toBeUndefined();
    } finally {
      if (orig !== undefined) process.env.HOME = orig;
    }
  });
});
