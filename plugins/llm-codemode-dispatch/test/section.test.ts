import { describe, expect, it, mock } from "bun:test";
import { makeApiSurfaceSection } from "../section.ts";
import type { ToolRegistration } from "llm-tools-registry/public";

function fakeRegistry(initial: ToolRegistration[] = []) {
  const list = [...initial];
  return {
    listRegistrations: () => [...list],
    push(r: ToolRegistration) { list.push(r); },
    pop(name: string) { const i = list.findIndex((r) => r.schema.name === name); if (i >= 0) list.splice(i, 1); },
  };
}

function reg(name: string, source: ToolRegistration["source"]): ToolRegistration {
  return {
    schema: { name, description: "", parameters: { type: "object", properties: {} } as any },
    handler: async () => null,
    source,
  };
}

describe("makeApiSurfaceSection", () => {
  it("returns a SystemPromptSection with id 'llm-codemode-dispatch:api' at priority 100", () => {
    const r = fakeRegistry();
    const { section } = makeApiSurfaceSection({
      registry: r as any,
      on: (() => () => {}) as any,
    });
    expect(section.id).toBe("llm-codemode-dispatch:api");
    expect(section.priority).toBe(100);
  });

  it("render() emits the assembled surface", async () => {
    const r = fakeRegistry([reg("a", { kind: "local" })]);
    const { section } = makeApiSurfaceSection({ registry: r as any, on: (() => () => {}) as any });
    const out = await section.render();
    expect(out).toContain("kaizen.tools");
  });

  it("subscribes to tools:registered and tools:unregistered to drive bumpGeneration on the host handle", async () => {
    const r = fakeRegistry();
    const subs = new Map<string, (p: unknown) => Promise<void>>();
    const on = mock((event: string, h: any) => { subs.set(event, h); return () => {}; });

    const onChange = mock(() => {});
    const { section, attach } = makeApiSurfaceSection({ registry: r as any, on: on as any });

    attach(onChange);
    expect(on).toHaveBeenCalledWith("tools:registered", expect.any(Function));
    expect(on).toHaveBeenCalledWith("tools:unregistered", expect.any(Function));

    r.push(reg("a", { kind: "local" }));
    await subs.get("tools:registered")!({ name: "a", source: { kind: "local" } });
    expect(onChange).toHaveBeenCalled();
    expect(section).toBeTruthy();
  });

  it("does NOT call onChange when the surface hash is unchanged (e.g., re-register with same content)", async () => {
    const r = fakeRegistry([reg("a", { kind: "local" })]);
    const subs = new Map<string, (p: unknown) => Promise<void>>();
    const on = (event: string, h: any) => { subs.set(event, h); return () => {}; };
    const onChange = mock(() => {});

    const { attach } = makeApiSurfaceSection({ registry: r as any, on: on as any });
    attach(onChange);
    onChange.mockClear();

    await subs.get("tools:registered")!({ name: "noop", source: { kind: "local" } });
    expect(onChange).not.toHaveBeenCalled();
  });
});
