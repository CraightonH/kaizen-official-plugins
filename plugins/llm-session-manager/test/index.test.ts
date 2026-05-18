import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../index";

function makeCtx() {
  const services = new Map<string, any>();
  const subs = new Map<string, Array<(payload: any) => void | Promise<void>>>();
  const sessionsBase = mkdtempSync(join(tmpdir(), "lifecycle-"));
  let registered: any = null;
  const cfgStore = {
    register: (spec: any) => { registered = spec; },
    get: (<T,>(_plugin: string): T => {
      const d = registered?.defaults ?? { sessionsBase };
      return { ...d } as unknown as T;
    }),
    set: async () => {},
    watch: () => () => {},
    list: () => [],
  };
  services.set("config:store", cfgStore);
  return {
    harness: { ref: "official/openai-compatible@0.1.0" },
    log: () => {},
    defineService: () => {},
    provideService: (name: string, impl: any) => services.set(name, impl),
    consumeService: () => {},
    useService: (name: string) => services.get(name),
    on: (event: string, handler: any) => {
      const list = subs.get(event) ?? [];
      list.push(handler);
      subs.set(event, list);
    },
    emit: async (event: string, payload?: any) => {
      for (const handler of subs.get(event) ?? []) await handler(payload);
      return [];
    },
    services,
    subs,
  };
}

describe("llm-session-manager plugin", () => {
  test("permissions cover scoped session files and trace event subscriptions", () => {
    expect(plugin.permissions?.tier).toBe("scoped");
    expect(plugin.permissions?.fs?.write).toContain("~/.kaizen/sessions/**");
    expect(plugin.permissions?.events?.subscribe).toContain("turn:start");
    expect(plugin.permissions?.events?.subscribe).toContain("codemode:error");
  });

  test("setup provides sessions:store and registers trace subscribers", async () => {
    const ctx = makeCtx();
    await plugin.setup!(ctx as any);
    expect(ctx.services.has("sessions:store")).toBe(true);
    expect(ctx.subs.has("turn:start")).toBe(true);
    expect(ctx.subs.has("llm:request")).toBe(true);
    expect(ctx.subs.has("tool:execute")).toBe(true);
  });
});
