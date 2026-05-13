import { test, expect } from "bun:test";
import plugin from "../index.ts";

function makeFakeCtx() {
  const services = new Map<string, unknown>();
  const consumed = new Set<string>();
  const log: string[] = [];
  const events = new Map<string, (p: unknown) => Promise<void>>();
  const registeredTools: Array<{ schema: any; handler: any }> = [];
  const fakeRegistry = {
    register(schema: any, handler: any) { registeredTools.push({ schema, handler }); return () => {}; },
    list() { return [{ name: "read_file", description: "", parameters: { type: "object" } }]; },
    listRegistrations() { return [{ schema: { name: "read_file", description: "", parameters: { type: "object" } }, source: { kind: "local" } }]; },
    invoke: async () => undefined,
  };
  services.set("tools:registry", fakeRegistry);
  return {
    config: {} as any,
    log: (m: string) => log.push(m),
    consumeService: (n: string) => { consumed.add(n); },
    defineService: () => {},
    provideService: () => {},
    on: (name: string, h: any) => { events.set(name, h); },
    emit: async () => {},
    useService: (n: string) => services.get(n),
    defineEvent: () => {},
    registeredTools,
    consumed,
  };
}

test("registers exactly one tool named execute_typescript", async () => {
  const ctx = makeFakeCtx();
  await (plugin as any).setup(ctx);
  expect(ctx.registeredTools.length).toBe(1);
  expect(ctx.registeredTools[0]?.schema.name).toBe("execute_typescript");
});

test("execute_typescript schema has a single 'code' string parameter", async () => {
  const ctx = makeFakeCtx();
  await (plugin as any).setup(ctx);
  const schema = ctx.registeredTools[0]!.schema;
  expect(schema.parameters?.type).toBe("object");
  expect(schema.parameters?.properties?.code?.type).toBe("string");
  expect(schema.parameters?.required).toContain("code");
});

test("description embeds the rendered kaizen.tools .d.ts surface", async () => {
  const ctx = makeFakeCtx();
  await (plugin as any).setup(ctx);
  const desc = ctx.registeredTools[0]!.schema.description as string;
  expect(desc).toContain("kaizen.tools");
});

test("does NOT provide dispatch:strategy", async () => {
  const ctx = makeFakeCtx();
  await (plugin as any).setup(ctx);
  expect(ctx.consumed.has("dispatch:strategy")).toBe(false);
});

test("consumes tools:registry only", async () => {
  const ctx = makeFakeCtx();
  await (plugin as any).setup(ctx);
  expect(ctx.consumed.has("tools:registry")).toBe(true);
});
