import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteJson, mergePluginSection } from "../atomic-write.ts";

const dirs: string[] = [];
function makeTmp(): string {
  const d = mkdtempSync(join(tmpdir(), "llm-config-test-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("atomicWriteJson", () => {
  it("writes JSON to a new file, creating parent dirs", () => {
    const dir = makeTmp();
    const path = join(dir, "a", "b", "config.json");
    atomicWriteJson(path, { x: 1 });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ x: 1 });
  });

  it("overwrites an existing file atomically (no leftover tmp)", () => {
    const dir = makeTmp();
    const path = join(dir, "config.json");
    atomicWriteJson(path, { x: 1 });
    atomicWriteJson(path, { x: 2 });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ x: 2 });
    expect(existsSync(path + ".tmp")).toBe(false);
  });
});

describe("mergePluginSection", () => {
  it("creates the section when missing", () => {
    const next = mergePluginSection({ plugins: {} }, "openai-llm", { baseUrl: "u" });
    expect(next).toEqual({ plugins: { "openai-llm": { baseUrl: "u" } } });
  });
  it("shallow-merges existing section keys", () => {
    const next = mergePluginSection(
      { plugins: { "openai-llm": { baseUrl: "u", defaultModel: "m" } } },
      "openai-llm",
      { defaultModel: "m2" },
    );
    expect(next.plugins["openai-llm"]).toEqual({ baseUrl: "u", defaultModel: "m2" });
  });
  it("leaves other plugins' sections alone", () => {
    const next = mergePluginSection(
      { plugins: { "openai-llm": { x: 1 }, "llm-codemode": { y: 2 } } },
      "openai-llm",
      { x: 9 },
    );
    expect(next.plugins["llm-codemode"]).toEqual({ y: 2 });
  });
});
