import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadSource,
  mergeRules,
  pickWriteTarget,
  appendAllowAtomic,
  ConfigFile,
} from "../config.ts";

let tmp: string;
beforeEach(() => {
  tmp = join(tmpdir(), `llm-tool-approval-test-${Date.now()}-${Math.random()}`);
  mkdirSync(tmp, { recursive: true });
});
afterEach(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

describe("loadSource", () => {
  it("returns empty lists when file missing", () => {
    const out = loadSource(join(tmp, "missing.json"));
    expect(out).toEqual({ allow: [], deny: [] });
  });

  it("parses valid JSON", () => {
    const p = join(tmp, "ok.json");
    writeFileSync(p, JSON.stringify({ allow: ["fs:*"], deny: ["fs:delete"] }));
    expect(loadSource(p)).toEqual({ allow: ["fs:*"], deny: ["fs:delete"] });
  });

  it("returns empty + logs when JSON is malformed", () => {
    const p = join(tmp, "bad.json");
    writeFileSync(p, "{not json");
    const logs: string[] = [];
    expect(loadSource(p, (m) => logs.push(m))).toEqual({ allow: [], deny: [] });
    expect(logs.length).toBeGreaterThan(0);
  });

  it("treats missing allow/deny as empty arrays", () => {
    const p = join(tmp, "partial.json");
    writeFileSync(p, JSON.stringify({ allow: ["x"] }));
    expect(loadSource(p)).toEqual({ allow: ["x"], deny: [] });
  });
});

describe("mergeRules", () => {
  it("unions all sources", () => {
    const out = mergeRules([
      { allow: ["a"], deny: ["x"] },
      { allow: ["b"], deny: [] },
      { allow: ["a"], deny: ["y"] },
    ]);
    expect(new Set(out.allow)).toEqual(new Set(["a", "b"]));
    expect(new Set(out.deny)).toEqual(new Set(["x", "y"]));
  });
});

describe("pickWriteTarget", () => {
  it("returns project path when <cwd>/.kaizen exists", () => {
    mkdirSync(join(tmp, ".kaizen"), { recursive: true });
    const t = pickWriteTarget({ cwd: tmp, home: "/home/u" });
    expect(t).toBe(join(tmp, ".kaizen", "plugins", "llm-tool-approval", "config.json"));
  });

  it("returns global path when no project context", () => {
    const t = pickWriteTarget({ cwd: tmp, home: "/home/u" });
    expect(t).toBe(join("/home/u", ".kaizen", "plugins", "llm-tool-approval", "config.json"));
  });
});

describe("appendAllowAtomic", () => {
  it("creates file if missing and writes sorted, deduped entries", () => {
    const target = join(tmp, ".kaizen", "plugins", "llm-tool-approval", "config.json");
    appendAllowAtomic(target, "fs:read_file");
    const raw = JSON.parse(readFileSync(target, "utf8"));
    expect(raw).toEqual({ allow: ["fs:read_file"], deny: [] });
  });

  it("dedupes and sorts on subsequent writes", () => {
    const target = join(tmp, "cfg.json");
    appendAllowAtomic(target, "b");
    appendAllowAtomic(target, "a");
    appendAllowAtomic(target, "a");
    const raw = JSON.parse(readFileSync(target, "utf8"));
    expect(raw.allow).toEqual(["a", "b"]);
  });

  it("preserves existing deny list", () => {
    const target = join(tmp, "cfg.json");
    writeFileSync(target, JSON.stringify({ allow: [], deny: ["dangerous"] }));
    appendAllowAtomic(target, "fs:read_file");
    const raw = JSON.parse(readFileSync(target, "utf8"));
    expect(raw).toEqual({ allow: ["fs:read_file"], deny: ["dangerous"] });
  });

  it("does not leave a .tmp file on success", () => {
    const target = join(tmp, "cfg.json");
    appendAllowAtomic(target, "x");
    expect(existsSync(target + ".tmp")).toBe(false);
  });
});
