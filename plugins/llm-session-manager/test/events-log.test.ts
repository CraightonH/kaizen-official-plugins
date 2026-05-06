import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openEventsLog, type EventLogEntry } from "../events-log";

function tmp() {
  return mkdtempSync(join(tmpdir(), "events-"));
}

describe("events-log", () => {
  test("append writes monotonic offsets", async () => {
    const path = join(tmp(), "events.jsonl");
    const log = openEventsLog(path);
    expect(log.nextOffset()).toBe(0);
    await log.append({ ts: 1, event: "turn:start", payload: { turnId: "t" } });
    await log.append({ ts: 2, event: "llm:request", payload: { turnId: "t" } });
    await log.flush();
    const parsed = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(parsed.map((entry) => entry.offset)).toEqual([0, 1]);
  });

  test("reopen continues offsets and truncates partial trailing line", async () => {
    const path = join(tmp(), "events.jsonl");
    writeFileSync(path, `{"offset":0,"ts":1,"event":"turn:start","payload":{}}\n{"offset":1`);
    const log = openEventsLog(path);
    expect(log.nextOffset()).toBe(1);
    expect(readFileSync(path, "utf8").split("\n").filter(Boolean)).toHaveLength(1);
  });

  test("readEvents supports fromOffset and limit", async () => {
    const path = join(tmp(), "events.jsonl");
    const log = openEventsLog(path);
    for (let i = 0; i < 5; i++) {
      await log.append({ ts: i, event: "turn:start", payload: { i } });
    }
    const out: EventLogEntry[] = [];
    for await (const event of log.readEvents({ fromOffset: 2, limit: 2 })) out.push(event);
    expect(out.map((event) => event.offset)).toEqual([2, 3]);
  });
});
