import { describe, it, expect, mock } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeMemoryStore } from "../service.ts";
import { CATALOG_START } from "../catalog.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "llm-memory-svc-"));
}

describe("makeMemoryStore (integration)", () => {
  it("put writes file AND regenerates MEMORY.md", async () => {
    const g = tmp();
    const svc = makeMemoryStore({ globalDir: g, projectDir: null, log: () => {} });
    await svc.put({ name: "x", description: "d", type: "user", scope: "global", body: "B" });
    expect(existsSync(join(g, "x.md"))).toBe(true);
    const idx = readFileSync(join(g, "MEMORY.md"), "utf8");
    expect(idx).toContain(CATALOG_START);
    expect(idx).toContain("- [x](x.md) — d");
  });
  it("readIndex returns the regenerated MEMORY.md", async () => {
    const g = tmp();
    const svc = makeMemoryStore({ globalDir: g, projectDir: null, log: () => {} });
    await svc.put({ name: "x", description: "d", type: "user", scope: "global", body: "" });
    const idx = await svc.readIndex("global");
    expect(idx).toContain("- [x](x.md) — d");
  });
  it("calls onChange after put", async () => {
    const g = tmp();
    const onChange = mock(() => {});
    const svc = makeMemoryStore({ globalDir: g, projectDir: null, log: () => {}, onChange });
    await svc.put({ name: "x", description: "d", type: "user", scope: "global", body: "" });
    expect(onChange).toHaveBeenCalledTimes(1);
  });
  it("calls onChange after remove", async () => {
    const g = tmp();
    const onChange = mock(() => {});
    const svc = makeMemoryStore({ globalDir: g, projectDir: null, log: () => {}, onChange });
    await svc.put({ name: "x", description: "d", type: "user", scope: "global", body: "" });
    const callsBefore = (onChange as any).mock.calls.length;
    await svc.remove("x", "global");
    expect((onChange as any).mock.calls.length).toBeGreaterThan(callsBefore);
  });
  it("works without onChange (default noop)", async () => {
    const g = tmp();
    const svc = makeMemoryStore({ globalDir: g, projectDir: null, log: () => {} });
    await expect(svc.put({ name: "x", description: "d", type: "user", scope: "global", body: "" })).resolves.toBeUndefined();
  });
});
