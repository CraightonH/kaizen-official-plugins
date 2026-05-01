// plugins/llm-local-tools/test/integration.test.ts
import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../index.ts";
import type { ToolSchema } from "../public.d.ts";

function makeFakeRegistry() {
  const map = new Map<string, { schema: ToolSchema; handler: (a: any, c: any) => Promise<unknown> }>();
  return {
    map,
    register(schema: ToolSchema, handler: (a: any, c: any) => Promise<unknown>) {
      if (map.has(schema.name)) throw new Error(`duplicate: ${schema.name}`);
      const entry = { schema, handler };
      map.set(schema.name, entry);
      return () => { if (map.get(schema.name) === entry) map.delete(schema.name); };
    },
    list(filter?: { tags?: string[]; names?: string[] }) {
      let out = [...map.values()].map(e => e.schema);
      if (filter?.tags?.length) out = out.filter(s => s.tags?.some(t => filter.tags!.includes(t)));
      if (filter?.names?.length) out = out.filter(s => filter.names!.includes(s.name));
      return out;
    },
    async invoke(name: string, args: unknown, ctx: any) {
      const e = map.get(name);
      if (!e) throw new Error(`unknown tool: ${name}`);
      return e.handler(args, ctx);
    },
  };
}

function makeCtx(registry: any) {
  return {
    log: () => {},
    useService: (n: string) => n === "tools:registry" ? registry : undefined,
    defineEvent: () => {},
    on: () => {},
    emit: async () => [],
    defineService: () => {},
    provideService: () => {},
  } as any;
}

describe("llm-local-tools integration", () => {
  it("registers seven tools with correct tags", async () => {
    const reg = makeFakeRegistry();
    await plugin.setup!(makeCtx(reg));
    expect(reg.list().map(s => s.name).sort()).toEqual(
      ["bash", "create", "edit", "glob", "grep", "read", "write"]
    );
    expect(reg.list({ tags: ["fs"] }).map(s => s.name).sort()).toEqual(
      ["create", "edit", "glob", "grep", "read", "write"]
    );
    expect(reg.list({ tags: ["shell"] }).map(s => s.name)).toEqual(["bash"]);
    expect(reg.list({ tags: ["local"] })).toHaveLength(7);
  });

  it("end-to-end: create then read then grep through registry.invoke", async () => {
    const reg = makeFakeRegistry();
    await plugin.setup!(makeCtx(reg));
    const dir = mkdtempSync(join(tmpdir(), "llt-int-"));
    try {
      const filePath = join(dir, "hello.txt");
      const ctx = { signal: new AbortController().signal, callId: "c1", log: () => {} };
      await reg.invoke("create", { path: filePath, content: "hi" }, ctx);
      const readOut = await reg.invoke("read", { path: filePath }, ctx) as string;
      expect(readOut).toContain("hi");
      const grepOut = await reg.invoke("grep", { pattern: "hi", path: dir }, ctx) as string;
      expect(grepOut).toContain("hello.txt");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("teardown removes every tool", async () => {
    const reg = makeFakeRegistry();
    const result = await plugin.setup!(makeCtx(reg)) as { teardown: () => Promise<void> };
    expect(reg.list()).toHaveLength(7);
    await result.teardown();
    expect(reg.list()).toHaveLength(0);
  });

  it("schemas validate as JSONSchema7-shaped (object + properties)", async () => {
    const reg = makeFakeRegistry();
    await plugin.setup!(makeCtx(reg));
    for (const s of reg.list()) {
      expect(s.parameters.type).toBe("object");
      expect(typeof s.description).toBe("string");
      expect(s.tags).toContain("local");
    }
  });
});
