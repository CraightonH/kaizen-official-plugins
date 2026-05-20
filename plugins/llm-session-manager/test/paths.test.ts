import { describe, expect, test } from "bun:test";
import { harnessRoot, indexFile, sessionPaths } from "../paths";

describe("paths", () => {
  test("harness and session paths are deterministic", () => {
    const root = harnessRoot("/base/sessions", "official_local");
    expect(root).toBe("/base/sessions/official_local");
    const paths = sessionPaths(root, "7f3e1234-89ab-cdef-0123-456789abcdef/reviewer");
    expect(paths.dir).toBe("/base/sessions/official_local/7f3e1234-89ab-cdef-0123-456789abcdef/reviewer");
    expect(paths.snapshot).toBe(`${paths.dir}/snapshot.json`);
    expect(paths.snapshotTmp).toBe(`${paths.dir}/snapshot.json.tmp`);
    expect(paths.events).toBe(`${paths.dir}/events.jsonl`);
    expect(indexFile(root)).toBe("/base/sessions/official_local/index.jsonl");
  });
});
