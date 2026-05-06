import { join } from "node:path";

export function harnessRoot(sessionsBase: string, harnessKey: string): string {
  return join(sessionsBase, harnessKey);
}

export interface SessionPaths {
  dir: string;
  snapshot: string;
  snapshotTmp: string;
  events: string;
}

export function sessionPaths(harnessDir: string, sessionId: string): SessionPaths {
  const dir = join(harnessDir, sessionId);
  return {
    dir,
    snapshot: join(dir, "snapshot.json"),
    snapshotTmp: join(dir, "snapshot.json.tmp"),
    events: join(dir, "events.jsonl"),
  };
}

export function indexFile(harnessDir: string): string {
  return join(harnessDir, "index.jsonl");
}
