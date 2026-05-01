import { describe, it, expect } from "bun:test";
import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeMemoryStore } from "../service.ts";
import { CATALOG_START, CATALOG_END } from "../catalog.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "llm-memory-fix-"));
}

describe("Claude-Code portability", () => {
  it("reads a pre-existing memory directory without losing data", async () => {
    const dest = tmp();
    cpSync(join(import.meta.dir, "fixtures", "claude-code-style-memory-dir"), dest, { recursive: true });
    const svc = makeMemoryStore({ globalDir: dest, projectDir: null, log: () => {} });
    const list = await svc.list();
    expect(list.map((e) => e.name).sort()).toEqual(["bun_git_dep_semver", "vault_namespace"]);
    const e = await svc.get("vault_namespace");
    expect(e!.description).toBe('Vault namespace is "admin"');
    expect(e!.created).toBeUndefined();
  });

  it("append-on-first-write adds markers without destroying user content", async () => {
    const dest = tmp();
    cpSync(join(import.meta.dir, "fixtures", "claude-code-style-memory-dir"), dest, { recursive: true });
    const svc = makeMemoryStore({ globalDir: dest, projectDir: null, log: () => {} });
    await svc.put({ name: "fresh", description: "new entry", type: "user", scope: "global", body: "hi" });
    const idx = readFileSync(join(dest, "MEMORY.md"), "utf8");
    expect(idx.startsWith("# User Profile")).toBe(true);
    expect(idx).toContain(CATALOG_START);
    expect(idx).toContain(CATALOG_END);
    expect(idx).toContain("- [fresh](fresh.md) — new entry");
  });

  it("hand-authored entry without created/updated parses correctly", async () => {
    const dest = tmp();
    const fs = await import("node:fs/promises");
    await fs.copyFile(
      join(import.meta.dir, "fixtures", "hand-authored-memory.md"),
      join(dest, "hand_authored.md"),
    );
    const svc = makeMemoryStore({ globalDir: dest, projectDir: null, log: () => {} });
    const e = await svc.get("hand_authored");
    expect(e).not.toBeNull();
    expect(e!.body).toContain("Loaded successfully");
  });
});
