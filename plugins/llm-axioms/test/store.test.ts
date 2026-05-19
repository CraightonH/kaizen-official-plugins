import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, existsSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeStore } from "../store.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "llm-axioms-store-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const sample = () => ({
  id: "a1",
  statement: "S",
  premises: ["p1"],
  reasoning: "r",
  scope: "default",
});

describe("store before any session is active", () => {
  it("list() returns empty array", () => {
    const s = makeStore({ axiomsDir: dir });
    expect(s.list()).toEqual([]);
  });
  it("record() rejects with no_active_session", async () => {
    const s = makeStore({ axiomsDir: dir });
    await expect(s.record(sample())).rejects.toThrow(/no_active_session/);
  });
  it("amend() and drop() reject with no_active_session", async () => {
    const s = makeStore({ axiomsDir: dir });
    await expect(s.amend("a1", { statement: "S2" })).rejects.toThrow(/no_active_session/);
    await expect(s.drop("a1", "wrong")).rejects.toThrow(/no_active_session/);
  });
  it("clear() is a no-op", async () => {
    const s = makeStore({ axiomsDir: dir });
    await s.clear();
  });
});

describe("store with an active session", () => {
  it("record() persists to disk and is readable via list/get", async () => {
    const s = makeStore({ axiomsDir: dir, now: () => 1_700_000_000_000 });
    await s.swapSession("sess-1");
    const out = await s.record(sample());
    expect(out.id).toBe("a1");
    expect(out.derivedAt).toBe(1_700_000_000_000);
    expect(s.list().length).toBe(1);
    expect(s.get("a1")!.statement).toBe("S");
    const file = readFileSync(join(dir, "sess-1.json"), "utf8");
    const parsed = JSON.parse(file);
    expect(parsed.sessionId).toBe("sess-1");
    expect(parsed.axioms.length).toBe(1);
    expect(parsed.version).toBe(1);
  });
  it("record() refuses duplicate ids", async () => {
    const s = makeStore({ axiomsDir: dir });
    await s.swapSession("sess-1");
    await s.record(sample());
    await expect(s.record(sample())).rejects.toThrow(/axiom_exists/);
  });
  it("amend() patches only provided fields and updates amendedAt", async () => {
    let t = 1000;
    const s = makeStore({ axiomsDir: dir, now: () => t });
    await s.swapSession("sess-1");
    await s.record(sample());
    t = 2000;
    const a = await s.amend("a1", { statement: "S2" });
    expect(a.statement).toBe("S2");
    expect(a.premises).toEqual(["p1"]);
    expect(a.derivedAt).toBe(1000);
    expect(a.amendedAt).toBe(2000);
  });
  it("amend() rejects unknown id", async () => {
    const s = makeStore({ axiomsDir: dir });
    await s.swapSession("sess-1");
    await expect(s.amend("ghost", { statement: "x" })).rejects.toThrow(/axiom_not_found/);
  });
  it("drop() removes the axiom and returns true", async () => {
    const s = makeStore({ axiomsDir: dir });
    await s.swapSession("sess-1");
    await s.record(sample());
    expect(await s.drop("a1", "wrong")).toBe(true);
    expect(s.list().length).toBe(0);
  });
  it("drop() rejects unknown id", async () => {
    const s = makeStore({ axiomsDir: dir });
    await s.swapSession("sess-1");
    await expect(s.drop("ghost", "wrong")).rejects.toThrow(/axiom_not_found/);
  });
  it("clear() removes all axioms in current session only", async () => {
    const s = makeStore({ axiomsDir: dir });
    await s.swapSession("sess-1");
    await s.record(sample());
    await s.record({ ...sample(), id: "a2" });
    await s.swapSession("sess-2");
    await s.record(sample());
    await s.clear();
    expect(s.list().length).toBe(0);
    await s.swapSession("sess-1");
    expect(s.list().length).toBe(2);
  });
});

describe("swapSession", () => {
  it("loads existing session file from disk", async () => {
    writeFileSync(
      join(dir, "sess-x.json"),
      JSON.stringify({ version: 1, sessionId: "sess-x", axioms: [{ id: "ax", statement: "s", premises: ["p"], reasoning: "r", scope: "z", derivedAt: 1 }] }),
    );
    const s = makeStore({ axiomsDir: dir });
    await s.swapSession("sess-x");
    expect(s.list().length).toBe(1);
    expect(s.get("ax")!.statement).toBe("s");
  });
  it("starts empty when session file does not exist", async () => {
    const s = makeStore({ axiomsDir: dir });
    await s.swapSession("brand-new");
    expect(s.list()).toEqual([]);
  });
  it("treats malformed JSON as empty (does not throw)", async () => {
    writeFileSync(join(dir, "broken.json"), "{not json");
    const s = makeStore({ axiomsDir: dir });
    await s.swapSession("broken");
    expect(s.list()).toEqual([]);
  });
  it("fires onChange once per swap", async () => {
    const s = makeStore({ axiomsDir: dir });
    let n = 0;
    s.onChange(() => { n++; });
    await s.swapSession("a");
    await s.swapSession("b");
    expect(n).toBe(2);
  });
});

describe("onChange", () => {
  it("fires exactly once per successful mutation", async () => {
    const s = makeStore({ axiomsDir: dir });
    await s.swapSession("sess-1");
    let n = 0;
    s.onChange(() => { n++; });
    await s.record(sample());
    expect(n).toBe(1);
    await s.amend("a1", { reasoning: "r2" });
    expect(n).toBe(2);
    await s.drop("a1", "stale");
    expect(n).toBe(3);
    await s.clear();
    expect(n).toBe(4);
  });
  it("does not fire on validation failure", async () => {
    const s = makeStore({ axiomsDir: dir });
    await s.swapSession("sess-1");
    let n = 0;
    s.onChange(() => { n++; });
    await expect(s.record({ ...sample(), id: "BAD ID" })).rejects.toThrow();
    expect(n).toBe(0);
  });
  it("unsubscribe stops further notifications", async () => {
    const s = makeStore({ axiomsDir: dir });
    await s.swapSession("sess-1");
    let n = 0;
    const off = s.onChange(() => { n++; });
    await s.record(sample());
    off();
    await s.amend("a1", { reasoning: "r2" });
    expect(n).toBe(1);
  });
});

describe("atomic writes", () => {
  it("leaves no tmp files after a successful write", async () => {
    const s = makeStore({ axiomsDir: dir });
    await s.swapSession("sess-1");
    await s.record(sample());
    const fs = require("node:fs");
    const remaining = fs.readdirSync(dir).filter((n: string) => n.includes(".tmp."));
    expect(remaining).toEqual([]);
  });
});
