import { describe, it, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadHookConfigs, type ConfigDeps, MUTABLE_EVENTS } from "../config.ts";

const VOCAB = new Set([
  "turn:start", "turn:end", "llm:before-call", "tool:before-execute",
  "codemode:before-execute", "tool:result", "llm:done",
]);

const HOME_FIXTURE = resolve(import.meta.dir, "fixtures/hooks.home.json");
const PROJECT_FIXTURE = resolve(import.meta.dir, "fixtures/hooks.project.json");

function makeDeps(overrides: Partial<ConfigDeps> = {}): ConfigDeps {
  return {
    home: "/home/u",
    cwd: "/work/proj",
    readFile: async () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); },
    ...overrides,
  };
}

describe("loadHookConfigs", () => {
  it("returns empty list when neither file exists", async () => {
    const r = await loadHookConfigs(makeDeps(), VOCAB);
    expect(r.entries).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it("loads home-only config", async () => {
    const r = await loadHookConfigs(makeDeps({
      readFile: async (p) => p.startsWith("/home/u/")
        ? readFile(HOME_FIXTURE, "utf8")
        : Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
    }), VOCAB);
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]!.event).toBe("turn:start");
  });

  it("merges home + project in home-first order", async () => {
    const r = await loadHookConfigs(makeDeps({
      readFile: async (p) => p.startsWith("/home/u/")
        ? readFile(HOME_FIXTURE, "utf8")
        : readFile(PROJECT_FIXTURE, "utf8"),
    }), VOCAB);
    expect(r.entries.map(e => e.event)).toEqual(["turn:start", "tool:before-execute"]);
  });

  it("throws on malformed JSON", async () => {
    await expect(loadHookConfigs(makeDeps({
      readFile: async () => "{not-json",
    }), VOCAB)).rejects.toThrow(/llm-hooks-shell.*malformed/i);
  });

  it("throws on unknown event name and surfaces the offending entry", async () => {
    await expect(loadHookConfigs(makeDeps({
      readFile: async (p) => p.startsWith("/home/u/")
        ? JSON.stringify({ hooks: [{ event: "totally:bogus", command: "true" }] })
        : Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
    }), VOCAB)).rejects.toThrow(/totally:bogus/);
  });

  it("warns (does not throw) on block_on_nonzero for non-mutable event", async () => {
    const r = await loadHookConfigs(makeDeps({
      readFile: async (p) => p.startsWith("/home/u/")
        ? JSON.stringify({ hooks: [{ event: "turn:end", command: "true", block_on_nonzero: true }] })
        : Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
    }), VOCAB);
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]!.block_on_nonzero).toBe(true); // retained, but ignored at runtime
    expect(r.warnings.join("\n")).toMatch(/block_on_nonzero.*turn:end/);
  });

  it("accepts block_on_nonzero on all three mutable events", async () => {
    const r = await loadHookConfigs(makeDeps({
      readFile: async (p) => p.startsWith("/home/u/")
        ? JSON.stringify({ hooks: [
            { event: "tool:before-execute", command: "true", block_on_nonzero: true },
            { event: "codemode:before-execute", command: "true", block_on_nonzero: true },
            { event: "llm:before-call", command: "true", block_on_nonzero: true },
          ]})
        : Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
    }), VOCAB);
    expect(r.warnings).toEqual([]);
    expect(r.entries).toHaveLength(3);
  });

  it("rejects entries missing event or command", async () => {
    await expect(loadHookConfigs(makeDeps({
      readFile: async (p) => p.startsWith("/home/u/")
        ? JSON.stringify({ hooks: [{ event: "turn:start" }] })
        : Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
    }), VOCAB)).rejects.toThrow(/command/);
  });

  it("MUTABLE_EVENTS contains exactly the three Spec 0 mutable events", () => {
    expect([...MUTABLE_EVENTS].sort()).toEqual([
      "codemode:before-execute",
      "llm:before-call",
      "tool:before-execute",
    ]);
  });
});
