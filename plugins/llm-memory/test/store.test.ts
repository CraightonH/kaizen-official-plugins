import { describe, it, expect, mock } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeStore } from "../store.ts";
import { renderEntry } from "../frontmatter.ts";
import type { MemoryEntry } from "../public.d.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "llm-memory-store-"));
}

function deps(globalDir: string | null, projectDir: string | null) {
  const calls: { dir: string }[] = [];
  return {
    deps: {
      globalDir,
      projectDir,
      regenerateIndex: mock(async (dir: string) => { calls.push({ dir }); }),
      log: () => {},
      now: () => "2026-04-30T12:00:00Z",
    },
    calls,
  };
}

const sample = (over: Partial<MemoryEntry> = {}): MemoryEntry => ({
  name: "x", description: "d", type: "user", scope: "global", body: "body\n", ...over,
});

describe("store.put + get round trip", () => {
  it("writes a global entry and reads it back identical", async () => {
    const g = tmp();
    const { deps: d } = deps(g, null);
    const s = makeStore(d);
    await s.put(sample({ scope: "global" }));
    const back = await s.get("x");
    expect(back).not.toBeNull();
    expect(back!.name).toBe("x");
    expect(back!.body).toBe("body\n");
    expect(back!.created).toBe("2026-04-30T12:00:00Z");
    expect(back!.updated).toBe("2026-04-30T12:00:00Z");
    expect(existsSync(join(g, "x.md"))).toBe(true);
  });
  it("preserves `created` across overwrites and bumps `updated`", async () => {
    const g = tmp();
    const { deps: d } = deps(g, null);
    let now = "2026-04-30T12:00:00Z";
    d.now = () => now;
    const s = makeStore(d);
    await s.put(sample({ scope: "global" }));
    now = "2026-05-01T12:00:00Z";
    await s.put(sample({ scope: "global", body: "new\n" }));
    const back = await s.get("x");
    expect(back!.created).toBe("2026-04-30T12:00:00Z");
    expect(back!.updated).toBe("2026-05-01T12:00:00Z");
    expect(back!.body).toBe("new\n");
  });
  it("project layer wins on collision when scope unspecified", async () => {
    const g = tmp(); const p = tmp();
    const { deps: d } = deps(g, p);
    const s = makeStore(d);
    writeFileSync(join(g, "x.md"), renderEntry(sample({ scope: "global", description: "G" })));
    writeFileSync(join(p, "x.md"), renderEntry(sample({ scope: "project", description: "P" })));
    const back = await s.get("x");
    expect(back!.description).toBe("P");
  });
  it("scope:'project' does NOT fall through to global", async () => {
    const g = tmp(); const p = tmp();
    const { deps: d } = deps(g, p);
    const s = makeStore(d);
    writeFileSync(join(g, "x.md"), renderEntry(sample({ scope: "global" })));
    expect(await s.get("x", { scope: "project" })).toBeNull();
  });
});

describe("store.list + search + filter", () => {
  it("list returns frontmatter only and respects type filter", async () => {
    const g = tmp();
    const { deps: d } = deps(g, null);
    const s = makeStore(d);
    await s.put(sample({ name: "u", type: "user", scope: "global" }));
    await s.put(sample({ name: "f", type: "feedback", scope: "global" }));
    const users = await s.list({ type: "user" });
    expect(users.map((e) => e.name)).toEqual(["u"]);
  });
  it("search matches description substring case-insensitively", async () => {
    const g = tmp();
    const { deps: d } = deps(g, null);
    const s = makeStore(d);
    await s.put(sample({ name: "v", description: "Vault namespace is admin", scope: "global" }));
    const out = await s.search("vault");
    expect(out.map((e) => e.name)).toEqual(["v"]);
  });
  it("ignores entries with parse errors but does not throw", async () => {
    const g = tmp();
    const { deps: d } = deps(g, null);
    writeFileSync(join(g, "broken.md"), "no frontmatter here");
    const s = makeStore(d);
    expect(await s.list()).toEqual([]);
  });
});

describe("store.put atomicity", () => {
  it("regenerates index after every put and remove", async () => {
    const g = tmp();
    const { deps: d, calls } = deps(g, null);
    const s = makeStore(d);
    await s.put(sample({ scope: "global" }));
    await s.remove("x", "global");
    expect(calls.length).toBe(2);
    expect(calls[0].dir).toBe(g);
  });
  it("temp file does not exist after a successful put", async () => {
    const g = tmp();
    const { deps: d } = deps(g, null);
    const s = makeStore(d);
    await s.put(sample({ scope: "global" }));
    const fs = await import("node:fs/promises");
    const after = await fs.readdir(g);
    expect(after.some((e) => e.includes(".tmp."))).toBe(false);
  });
  it("concurrent puts of different names both land", async () => {
    const g = tmp();
    const { deps: d } = deps(g, null);
    const s = makeStore(d);
    await Promise.all([
      s.put(sample({ name: "a", scope: "global" })),
      s.put(sample({ name: "b", scope: "global" })),
    ]);
    expect(existsSync(join(g, "a.md"))).toBe(true);
    expect(existsSync(join(g, "b.md"))).toBe(true);
  });
});

describe("store.readIndex", () => {
  it("returns empty string when MEMORY.md absent", async () => {
    const g = tmp();
    const { deps: d } = deps(g, null);
    const s = makeStore(d);
    expect(await s.readIndex("global")).toBe("");
  });
  it("returns the file body when present", async () => {
    const g = tmp();
    writeFileSync(join(g, "MEMORY.md"), "# hi\n");
    const { deps: d } = deps(g, null);
    const s = makeStore(d);
    expect(await s.readIndex("global")).toBe("# hi\n");
  });
});

describe("store.remove", () => {
  it("is a no-op for a missing entry", async () => {
    const g = tmp();
    const { deps: d } = deps(g, null);
    const s = makeStore(d);
    await s.remove("missing", "global");
    expect(true).toBe(true);
  });
});
