import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { ChatMessage } from "llm-contracts/public";

export interface Snapshot {
  schemaVersion: 1;
  id: string;
  harness: string;
  parentSessionId?: string;
  alias?: string;
  agentName?: string;
  model?: string;
  metadata: Record<string, unknown>;
  createdAt: number;
  lastTurnAt?: number;
  pluginFingerprint: string[];
  messages: ChatMessage[];
}

export async function writeSnapshotAtomic(path: string, tmpPath: string, snap: Snapshot): Promise<void> {
  if (snap.schemaVersion !== 1) {
    throw new Error(`writeSnapshotAtomic: unsupported schemaVersion ${snap.schemaVersion}`);
  }
  mkdirSync(dirname(path), { recursive: true });
  try {
    unlinkSync(tmpPath);
  } catch {
    // No stale temp file.
  }

  const fd = openSync(tmpPath, "w");
  try {
    writeFileSync(fd, JSON.stringify(snap));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, path);
}

export function readSnapshot(path: string): Snapshot {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Snapshot;
  if (parsed.schemaVersion !== 1) {
    throw new Error(`readSnapshot: unsupported schemaVersion ${parsed.schemaVersion}`);
  }
  return parsed;
}
