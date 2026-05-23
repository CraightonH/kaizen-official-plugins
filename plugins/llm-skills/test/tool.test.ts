import { describe, it, expect, mock } from "bun:test";
import { LOAD_SKILL_SCHEMA, makeLoadSkillHandler } from "../tool.ts";
import type { SkillsRegistryService } from "../public";

function fakeRegistry(): SkillsRegistryService {
  return {
    list: () => [{ name: "git-rebase", description: "d", tokens: 42 }],
    load: async (name: string) => {
      if (name === "git-rebase") return "BODY";
      throw new Error(`unknown skill: ${name}`);
    },
    register: () => () => {},
    rescan: async () => {},
  } as any;
}

describe("LOAD_SKILL_SCHEMA", () => {
  it("matches the Spec 7 contract", () => {
    expect(LOAD_SKILL_SCHEMA.name).toBe("load_skill");
    expect(LOAD_SKILL_SCHEMA.description).toMatch(/Load the full body/);
    expect(LOAD_SKILL_SCHEMA.parameters.type).toBe("object");
    expect(LOAD_SKILL_SCHEMA.parameters.properties?.name).toBeDefined();
    expect(LOAD_SKILL_SCHEMA.parameters.required).toEqual(["name"]);
    expect(LOAD_SKILL_SCHEMA.parameters.additionalProperties).toBe(false);
    expect(LOAD_SKILL_SCHEMA.tags).toEqual(["skills", "synthetic"]);
  });
});

describe("makeLoadSkillHandler", () => {
  it("returns { name, tokens, body } and emits skill:loaded", async () => {
    const emit = mock(async () => {});
    const handler = makeLoadSkillHandler(fakeRegistry(), emit);
    const ctx: any = { signal: new AbortController().signal, callId: "c1", log: () => {} };
    const result = await handler({ name: "git-rebase" }, ctx);
    expect(result).toEqual({ name: "git-rebase", tokens: 42, body: "BODY" });
    expect(emit).toHaveBeenCalledWith("skill:loaded", { name: "git-rebase", tokens: 42 });
  });

  it("throws on missing/empty name (no event)", async () => {
    const emit = mock(async () => {});
    const handler = makeLoadSkillHandler(fakeRegistry(), emit);
    const ctx: any = { signal: new AbortController().signal, callId: "c1", log: () => {} };
    await expect(handler({}, ctx)).rejects.toThrow(/name/i);
    await expect(handler({ name: "" }, ctx)).rejects.toThrow(/name/i);
    await expect(handler({ name: 7 } as any, ctx)).rejects.toThrow(/name/i);
    expect(emit).not.toHaveBeenCalled();
  });

  it("propagates unknown-skill errors and does not emit", async () => {
    const emit = mock(async () => {});
    const handler = makeLoadSkillHandler(fakeRegistry(), emit);
    const ctx: any = { signal: new AbortController().signal, callId: "c1", log: () => {} };
    await expect(handler({ name: "nope" }, ctx)).rejects.toThrow(/unknown skill/i);
    expect(emit).not.toHaveBeenCalled();
  });

  it("uses tokens from manifest list when available, otherwise body length heuristic", async () => {
    const emit = mock(async () => {});
    const reg: SkillsRegistryService = {
      list: () => [{ name: "x", description: "d" }],   // tokens absent
      load: async () => "abcd",                         // 4 chars → 1 token
      register: () => () => {},
      rescan: async () => {},
    } as any;
    const handler = makeLoadSkillHandler(reg, emit);
    const ctx: any = { signal: new AbortController().signal, callId: "c1", log: () => {} };
    const r = await handler({ name: "x" }, ctx);
    expect(r).toEqual({ name: "x", tokens: 1, body: "abcd" });
    expect(emit).toHaveBeenCalledWith("skill:loaded", { name: "x", tokens: 1 });
  });
});

describe("makeLoadSkillHandler — baseDir preamble", () => {
  it("prepends 'Base directory for this skill:' line when manifest.baseDir is set", async () => {
    const registry = {
      list: () => [{ name: "alpha", description: "d", tokens: 10, baseDir: "/abs/skills/alpha" }],
      load: async () => "BODY",
      register: () => () => {},
      rescan: async () => ({ changed: false, count: 0 }),
    };
    const emit = mock(async () => {});
    const handler = makeLoadSkillHandler(registry as any, emit);
    const result = await handler({ name: "alpha" }, { signal: new AbortController().signal, callId: "c1", log: () => {} }) as { body: string };
    expect(result.body).toBe("Base directory for this skill: /abs/skills/alpha\n\nBODY");
  });

  it("returns body verbatim when manifest.baseDir is unset", async () => {
    const registry = {
      list: () => [{ name: "alpha", description: "d", tokens: 10 }],
      load: async () => "BODY",
      register: () => () => {},
      rescan: async () => ({ changed: false, count: 0 }),
    };
    const handler = makeLoadSkillHandler(registry as any, async () => {});
    const result = await handler({ name: "alpha" }, { signal: new AbortController().signal, callId: "c1", log: () => {} }) as { body: string };
    expect(result.body).toBe("BODY");
  });

  it("treats an empty-string baseDir as unset (no preamble)", async () => {
    const registry = {
      list: () => [{ name: "alpha", description: "d", tokens: 10, baseDir: "" }],
      load: async () => "BODY",
      register: () => () => {},
      rescan: async () => ({ changed: false, count: 0 }),
    };
    const handler = makeLoadSkillHandler(registry as any, async () => {});
    const result = await handler({ name: "alpha" }, { signal: new AbortController().signal, callId: "c1", log: () => {} }) as { body: string };
    expect(result.body).toBe("BODY");
  });
});
