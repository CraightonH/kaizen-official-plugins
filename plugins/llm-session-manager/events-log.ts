import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export interface EventLogEntry {
  offset: number;
  ts: number;
  event: string;
  payload: { turnId?: string; sessionId?: string } & Record<string, unknown>;
}

export interface EventsLog {
  nextOffset(): number;
  append(entry: Omit<EventLogEntry, "offset">): Promise<EventLogEntry>;
  flush(): Promise<void>;
  readEvents(opts?: { fromOffset?: number; limit?: number }): AsyncIterable<EventLogEntry>;
  close(): void;
}

export function openEventsLog(path: string): EventsLog {
  mkdirSync(dirname(path), { recursive: true });
  let nextOffset = 0;

  if (existsSync(path)) {
    const raw = readFileSync(path, "utf8");
    const lastNewline = raw.lastIndexOf("\n");
    if (raw.length > 0 && lastNewline < raw.length - 1) {
      writeFileSync(path, lastNewline >= 0 ? raw.slice(0, lastNewline + 1) : "");
    }
    const cleaned = readFileSync(path, "utf8");
    const lines = cleaned.split("\n").filter(Boolean);
    if (lines.length > 0) {
      try {
        const last = JSON.parse(lines[lines.length - 1]!) as EventLogEntry;
        nextOffset = last.offset + 1;
      } catch {
        nextOffset = 0;
      }
    }
  }

  return {
    nextOffset() {
      return nextOffset;
    },

    async append(entry) {
      const full: EventLogEntry = { offset: nextOffset++, ...entry };
      appendFileSync(path, JSON.stringify(full) + "\n");
      return full;
    },

    async flush() {
      if (!existsSync(path)) return;
      const fd = openSync(path, "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    },

    async *readEvents(opts) {
      if (!existsSync(path) || statSync(path).size === 0) return;
      const fromOffset = opts?.fromOffset ?? 0;
      const limit = opts?.limit ?? Number.POSITIVE_INFINITY;
      let yielded = 0;
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line) continue;
        let parsed: EventLogEntry;
        try {
          parsed = JSON.parse(line) as EventLogEntry;
        } catch {
          continue;
        }
        if (parsed.offset < fromOffset) continue;
        yield parsed;
        yielded++;
        if (yielded >= limit) return;
      }
    },

    close() {
      // No persistent fd is held.
    },
  };
}
