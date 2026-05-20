import { describe, expect, it } from "bun:test";
import { createRegistry } from "../registry.ts";
import { makePromptToolHandlers } from "../tool.ts";

function makeFixture() {
  const emitted: Array<{ event: string; payload: unknown }> = [];
  const registry = createRegistry({
    events: { promptRebuilt: "prompt:rebuilt" },
    emit: async (event, payload) => { emitted.push({ event, payload }); },
  });
  let reloaded = 0;
  const reloadIdentity = async () => { reloaded++; };
  const tools = makePromptToolHandlers({ registry, reloadIdentity });
  return { registry, tools, emitted, reloaded: () => reloaded };
}

const fakeToolCtx = {
  signal: new AbortController().signal,
  callId: "test",
  log: () => {},
};

describe("prompt_show", () => {
  it("returns sections sorted by priority", async () => {
    const { registry, tools } = makeFixture();
    registry.register({ id: "high", priority: 100, render: () => "HIGH" });
    registry.register({ id: "low", priority: 10, render: () => "LOW" });
    registry.register({ id: "mid", priority: 50, render: () => "MID" });

    const result = (await tools.show.handler({ stats: false }, fakeToolCtx)) as {
      generation: number;
      sections: Array<{ id: string; priority: number; title?: string; body: string | null }>;
    };

    expect(result.sections.map((s) => s.id)).toEqual(["low", "mid", "high"]);
    expect(result.sections[0].body).toBe("LOW");
    expect(result.sections[1].body).toBe("MID");
    expect(result.sections[2].body).toBe("HIGH");
    expect(typeof result.generation).toBe("number");
  });

  it("returns body: null for disabled sections", async () => {
    const { registry, tools } = makeFixture();
    registry.register({ id: "a", priority: 10, render: () => "VISIBLE" });
    registry.disable("a");

    const result = (await tools.show.handler({}, fakeToolCtx)) as any;
    expect(result.sections.find((s: any) => s.id === "a").body).toBeNull();
  });

  it("with stats: true populates chars and includes generation", async () => {
    const { registry, tools } = makeFixture();
    registry.register({ id: "x", priority: 10, render: () => "hello" });

    const result = (await tools.show.handler({ stats: true }, fakeToolCtx)) as any;
    expect(result.generation).toBeGreaterThan(0);
    const xSection = result.sections.find((s: any) => s.id === "x");
    expect(xSection.chars).toBe(5);
  });
});

describe("prompt_reload", () => {
  it("calls reloadIdentity and returns ok", async () => {
    const { tools, reloaded } = makeFixture();
    const result = await tools.reload.handler({}, fakeToolCtx);
    expect(result).toEqual({ ok: true, message: "identity reloaded" });
    expect(reloaded()).toBe(1);
  });
});

describe("prompt_disable", () => {
  it("throws for non-existent id", async () => {
    const { tools } = makeFixture();
    await expect(
      tools.disable.handler({ sectionId: "nope" }, fakeToolCtx),
    ).rejects.toThrow('no section with id "nope"');
  });

  it("throws for missing sectionId", async () => {
    const { tools } = makeFixture();
    await expect(
      tools.disable.handler({}, fakeToolCtx),
    ).rejects.toThrow("'sectionId' is required");
  });

  it("throws for empty sectionId", async () => {
    const { tools } = makeFixture();
    await expect(
      tools.disable.handler({ sectionId: "" }, fakeToolCtx),
    ).rejects.toThrow("'sectionId' is required");
  });

  it("throws for non-object args", async () => {
    const { tools } = makeFixture();
    await expect(
      tools.disable.handler("string", fakeToolCtx),
    ).rejects.toThrow("args must be an object");
  });

  it("disables the section and returns ok", async () => {
    const { registry, tools } = makeFixture();
    registry.register({ id: "a", priority: 10, render: () => "BODY" });
    const result = await tools.disable.handler({ sectionId: "a" }, fakeToolCtx);
    expect(result).toEqual({ ok: true, sectionId: "a", action: "disabled" });
    expect(registry.has("a")).toBe(true); // still registered, just disabled
  });
});

describe("prompt_enable", () => {
  it("throws for non-existent id", async () => {
    const { tools } = makeFixture();
    await expect(
      tools.enable.handler({ sectionId: "nope" }, fakeToolCtx),
    ).rejects.toThrow('no section with id "nope"');
  });

  it("throws for missing sectionId", async () => {
    const { tools } = makeFixture();
    await expect(
      tools.enable.handler({}, fakeToolCtx),
    ).rejects.toThrow("'sectionId' is required");
  });

  it("enables a disabled section and returns ok", async () => {
    const { registry, tools } = makeFixture();
    registry.register({ id: "a", priority: 10, render: () => "RESTORED" });
    await tools.disable.handler({ sectionId: "a" }, fakeToolCtx);
    expect(await registry.renderSection("a")).toBeUndefined();

    const result = await tools.enable.handler({ sectionId: "a" }, fakeToolCtx);
    expect(result).toEqual({ ok: true, sectionId: "a", action: "enabled" });
    expect(await registry.renderSection("a")).toBe("RESTORED");
  });
});

describe("schema validation", () => {
  it("prompt_show schema has correct name, additionalProperties, and tags", () => {
    const { tools } = makeFixture();
    expect(tools.show.schema.name).toBe("prompt_show");
    expect(tools.show.schema.parameters.additionalProperties).toBe(false);
    expect(tools.show.schema.tags).toContain("prompt");
    expect(tools.show.schema.tags).toContain("diagnostic");
    expect(tools.show.schema.tags).toContain("synthetic");
  });

  it("prompt_reload schema has correct name", () => {
    const { tools } = makeFixture();
    expect(tools.reload.schema.name).toBe("prompt_reload");
    expect(tools.reload.schema.parameters.additionalProperties).toBe(false);
    expect(tools.reload.schema.tags).toContain("prompt");
  });

  it("prompt_disable schema has correct name, required fields, and tags", () => {
    const { tools } = makeFixture();
    expect(tools.disable.schema.name).toBe("prompt_disable");
    expect((tools.disable.schema.parameters as any).required).toEqual(["sectionId"]);
    expect(tools.disable.schema.parameters.additionalProperties).toBe(false);
    expect(tools.disable.schema.tags).toContain("prompt");
    expect(tools.disable.schema.tags).toContain("diagnostic");
    expect(tools.disable.schema.tags).toContain("synthetic");
  });

  it("prompt_enable schema has correct name", () => {
    const { tools } = makeFixture();
    expect(tools.enable.schema.name).toBe("prompt_enable");
    expect(tools.enable.schema.parameters.additionalProperties).toBe(false);
    expect(tools.enable.schema.tags).toContain("prompt");
    expect(tools.enable.schema.tags).toContain("diagnostic");
    expect(tools.enable.schema.tags).toContain("synthetic");
  });
});
