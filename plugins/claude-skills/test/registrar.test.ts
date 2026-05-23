import { describe, it, expect, mock } from "bun:test";
import type { SkillsRegistryService, SkillManifest } from "llm-contracts/public";
import { reconcile, type RegistrarSnapshot } from "../registrar.ts";
import type { ScannedSkill } from "../scan.ts";

function makeFakeRegistry() {
  const calls: { kind: "register" | "unregister"; name: string }[] = [];
  const unregisters = new Map<string, () => void>();
  const registry: SkillsRegistryService = {
    list: () => [] as SkillManifest[],
    load: async () => "",
    rescan: async () => ({ changed: false, count: 0 }),
    register: (manifest, _loader) => {
      calls.push({ kind: "register", name: manifest.name });
      const u = mock(() => { calls.push({ kind: "unregister", name: manifest.name }); });
      unregisters.set(manifest.name, u);
      return u;
    },
  };
  return { registry, calls };
}

function skill(name: string, body: string, baseDir?: string): ScannedSkill {
  const dir = baseDir ?? `/abs/${name}`;
  return {
    name,
    description: `d for ${name}`,
    baseDir: dir,
    body,
    layer: "user",
    sourcePath: `${dir}/SKILL.md`,
  };
}

describe("reconcile", () => {
  it("registers all skills on the first pass", () => {
    const { registry, calls } = makeFakeRegistry();
    const snap: RegistrarSnapshot = new Map();
    const next = reconcile(registry, [skill("a", "A"), skill("b", "B")], snap);
    expect(calls.map(c => `${c.kind}:${c.name}`)).toEqual(["register:a", "register:b"]);
    expect(next.size).toBe(2);
  });

  it("is a no-op when the input is unchanged", () => {
    const { registry, calls } = makeFakeRegistry();
    let snap = reconcile(registry, [skill("a", "A")], new Map());
    calls.length = 0;
    snap = reconcile(registry, [skill("a", "A")], snap);
    expect(calls).toEqual([]);
    expect(snap.size).toBe(1);
  });

  it("unregisters a skill that disappeared", () => {
    const { registry, calls } = makeFakeRegistry();
    let snap = reconcile(registry, [skill("a", "A"), skill("b", "B")], new Map());
    calls.length = 0;
    snap = reconcile(registry, [skill("a", "A")], snap);
    expect(calls.map(c => `${c.kind}:${c.name}`)).toEqual(["unregister:b"]);
    expect(snap.size).toBe(1);
  });

  it("registers a newly-appearing skill", () => {
    const { registry, calls } = makeFakeRegistry();
    let snap = reconcile(registry, [skill("a", "A")], new Map());
    calls.length = 0;
    snap = reconcile(registry, [skill("a", "A"), skill("b", "B")], snap);
    expect(calls.map(c => `${c.kind}:${c.name}`)).toEqual(["register:b"]);
    expect(snap.size).toBe(2);
  });

  it("re-registers a skill whose body changed", () => {
    const { registry, calls } = makeFakeRegistry();
    let snap = reconcile(registry, [skill("a", "A1")], new Map());
    calls.length = 0;
    snap = reconcile(registry, [skill("a", "A2")], snap);
    expect(calls.map(c => `${c.kind}:${c.name}`)).toEqual(["unregister:a", "register:a"]);
    expect(snap.size).toBe(1);
  });

  it("re-registers a skill whose baseDir flipped even when body is unchanged", () => {
    const { registry, calls } = makeFakeRegistry();
    let snap = reconcile(registry, [skill("shared", "BODY", "/user/.claude/skills/shared")], new Map());
    calls.length = 0;
    snap = reconcile(registry, [skill("shared", "BODY", "/project/.claude/skills/shared")], snap);
    expect(calls.map(c => `${c.kind}:${c.name}`)).toEqual(["unregister:shared", "register:shared"]);
    expect(snap.size).toBe(1);
  });

  it("passes baseDir, description, and tokens through to the manifest", async () => {
    const captured: SkillManifest[] = [];
    const registry: SkillsRegistryService = {
      list: () => [],
      load: async () => "",
      rescan: async () => ({ changed: false, count: 0 }),
      register: (manifest) => { captured.push(manifest); return () => {}; },
    };
    const s: ScannedSkill = { ...skill("a", "BODY"), tokens: 42 };
    reconcile(registry, [s], new Map());
    expect(captured[0]?.baseDir).toBe("/abs/a");
    expect(captured[0]?.description).toBe("d for a");
    expect(captured[0]?.tokens).toBe(42);
  });

  it("falls back to body-length heuristic when tokens is absent", () => {
    const captured: SkillManifest[] = [];
    const registry: SkillsRegistryService = {
      list: () => [], load: async () => "", rescan: async () => ({ changed: false, count: 0 }),
      register: (m) => { captured.push(m); return () => {}; },
    };
    reconcile(registry, [skill("a", "1234567890")], new Map());
    expect(captured[0]?.tokens).toBe(Math.ceil("1234567890".length / 4));
  });
});
