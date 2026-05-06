import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSnapshot, writeSnapshotAtomic, type Snapshot } from "../snapshot";

function tmp() {
  return mkdtempSync(join(tmpdir(), "snapshot-"));
}

const sample: Snapshot = {
  schemaVersion: 1,
  id: "7f3e1234-89ab-cdef-0123-456789abcdef",
  harness: "h",
  metadata: {},
  createdAt: 1,
  pluginFingerprint: [],
  messages: [],
};

describe("snapshot", () => {
  test("writeSnapshotAtomic round-trips and removes tmp", async () => {
    const dir = tmp();
    const path = join(dir, "snapshot.json");
    const tmpPath = join(dir, "snapshot.json.tmp");
    await writeSnapshotAtomic(path, tmpPath, sample);
    expect(await readSnapshot(path)).toEqual(sample);
    expect(existsSync(tmpPath)).toBe(false);
  });

  test("readSnapshot rejects missing, invalid, or wrong schema", () => {
    const dir = tmp();
    expect(() => readSnapshot(join(dir, "missing.json"))).toThrow();
    writeFileSync(join(dir, "bad.json"), "{ no");
    expect(() => readSnapshot(join(dir, "bad.json"))).toThrow();
    writeFileSync(join(dir, "schema.json"), JSON.stringify({ ...sample, schemaVersion: 99 }));
    expect(() => readSnapshot(join(dir, "schema.json"))).toThrow(/schema/i);
  });

  test("writeSnapshotAtomic ignores stale tmp", async () => {
    const dir = tmp();
    const path = join(dir, "snapshot.json");
    const tmpPath = join(dir, "snapshot.json.tmp");
    writeFileSync(tmpPath, "{ half");
    await writeSnapshotAtomic(path, tmpPath, sample);
    expect(readSnapshot(path)).toEqual(sample);
  });
});
