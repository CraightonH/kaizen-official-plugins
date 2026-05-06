import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openIndex, rebuildIndexFromDisk } from "../index-jsonl";

function tmp() {
  return mkdtempSync(join(tmpdir(), "index-"));
}

describe("index-jsonl", () => {
  test("replays create/update/delete ops", async () => {
    const file = join(tmp(), "index.jsonl");
    const idx = openIndex(file);
    await idx.appendCreate({ id: "a", harness: "h", createdAt: 1 });
    await idx.appendCreate({ id: "b", harness: "h", createdAt: 2 });
    await idx.appendUpdate({ id: "b", lastTurnAt: 99 });
    await idx.appendDelete({ id: "a", cascade: false });
    const reopened = openIndex(file);
    expect(reopened.list().map((entry) => [entry.id, entry.lastTurnAt])).toEqual([["b", 99]]);
  });

  test("rebuildIndexFromDisk walks nested snapshot files", () => {
    const harnessDir = join(tmp(), "h");
    mkdirSync(join(harnessDir, "uuid-a", "child"), { recursive: true });
    writeFileSync(
      join(harnessDir, "uuid-a", "snapshot.json"),
      JSON.stringify({ schemaVersion: 1, id: "uuid-a", harness: "h", metadata: {}, createdAt: 1, pluginFingerprint: [], messages: [] }),
    );
    writeFileSync(
      join(harnessDir, "uuid-a", "child", "snapshot.json"),
      JSON.stringify({ schemaVersion: 1, id: "uuid-a/child", harness: "h", parentSessionId: "uuid-a", metadata: {}, createdAt: 2, pluginFingerprint: [], messages: [] }),
    );
    expect(rebuildIndexFromDisk(harnessDir).map((entry) => entry.id).sort()).toEqual(["uuid-a", "uuid-a/child"]);
  });

  test("openIndex falls back to disk walk when missing or corrupt", () => {
    const harnessDir = join(tmp(), "h");
    mkdirSync(join(harnessDir, "uuid-a"), { recursive: true });
    writeFileSync(
      join(harnessDir, "uuid-a", "snapshot.json"),
      JSON.stringify({ schemaVersion: 1, id: "uuid-a", harness: "h", metadata: {}, createdAt: 1, pluginFingerprint: [], messages: [] }),
    );
    expect(openIndex(join(harnessDir, "index.jsonl"), { harnessDir }).list().map((e) => e.id)).toEqual(["uuid-a"]);
    writeFileSync(join(harnessDir, "index.jsonl"), "{ bad");
    expect(openIndex(join(harnessDir, "index.jsonl"), { harnessDir }).list().map((e) => e.id)).toEqual(["uuid-a"]);
  });
});
