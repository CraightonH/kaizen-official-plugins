import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { readSnapshot } from "./snapshot";

export interface IndexEntry {
  id: string;
  harness: string;
  parentSessionId?: string;
  alias?: string;
  agentName?: string;
  createdAt: number;
  lastTurnAt?: number;
}

export interface Index {
  list(): IndexEntry[];
  get(id: string): IndexEntry | undefined;
  appendCreate(e: IndexEntry): Promise<void>;
  appendUpdate(u: { id: string; lastTurnAt: number }): Promise<void>;
  appendRename(r: { id: string; alias: string | undefined }): Promise<void>;
  appendDelete(d: { id: string; cascade: boolean }): Promise<void>;
}

export function openIndex(file: string, opts?: { harnessDir?: string }): Index {
  mkdirSync(dirname(file), { recursive: true });
  const map = new Map<string, IndexEntry>();

  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line) continue;
      try {
        applyOp(map, JSON.parse(line));
      } catch {
        map.clear();
        if (opts?.harnessDir && existsSync(opts.harnessDir)) {
          for (const entry of rebuildIndexFromDisk(opts.harnessDir)) map.set(entry.id, entry);
        }
        break;
      }
    }
  } else if (opts?.harnessDir && existsSync(opts.harnessDir)) {
    for (const entry of rebuildIndexFromDisk(opts.harnessDir)) map.set(entry.id, entry);
  }

  return {
    list: () => Array.from(map.values()).sort((a, b) => a.createdAt - b.createdAt),
    get: (id) => map.get(id),
    async appendCreate(entry) {
      appendFileSync(file, JSON.stringify({ op: "create", ...entry }) + "\n");
      map.set(entry.id, entry);
    },
    async appendUpdate(update) {
      appendFileSync(file, JSON.stringify({ op: "update", ...update }) + "\n");
      const current = map.get(update.id);
      if (current) map.set(update.id, { ...current, lastTurnAt: update.lastTurnAt });
    },
    async appendRename(rename) {
      appendFileSync(file, JSON.stringify({ op: "rename", ...rename }) + "\n");
      const current = map.get(rename.id);
      if (current) {
        const next: IndexEntry = { ...current };
        if (rename.alias) next.alias = rename.alias;
        else delete next.alias;
        map.set(rename.id, next);
      }
    },
    async appendDelete(del) {
      appendFileSync(file, JSON.stringify({ op: "delete", ...del }) + "\n");
      map.delete(del.id);
      if (del.cascade) {
        for (const id of Array.from(map.keys())) {
          if (id.startsWith(del.id + "/")) map.delete(id);
        }
      }
    },
  };
}

function applyOp(map: Map<string, IndexEntry>, op: any): void {
  if (op?.op === "create") {
    const { op: _op, ...entry } = op;
    map.set(entry.id, entry as IndexEntry);
  } else if (op?.op === "update") {
    const current = map.get(op.id);
    if (current) map.set(op.id, { ...current, lastTurnAt: op.lastTurnAt });
  } else if (op?.op === "rename") {
    const current = map.get(op.id);
    if (current) {
      const next: IndexEntry = { ...current };
      if (op.alias) next.alias = op.alias;
      else delete next.alias;
      map.set(op.id, next);
    }
  } else if (op?.op === "delete") {
    map.delete(op.id);
    if (op.cascade) {
      for (const id of Array.from(map.keys())) {
        if (id.startsWith(op.id + "/")) map.delete(id);
      }
    }
  }
}

export function rebuildIndexFromDisk(harnessDir: string): IndexEntry[] {
  const out: IndexEntry[] = [];
  function walk(dir: string): void {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isFile() && entry.name === "snapshot.json") {
        try {
          const snap = readSnapshot(path);
          out.push({
            id: snap.id,
            harness: snap.harness,
            parentSessionId: snap.parentSessionId,
            alias: snap.alias,
            agentName: snap.agentName,
            createdAt: snap.createdAt,
            lastTurnAt: snap.lastTurnAt,
          });
        } catch {
          // Best-effort rebuild skips corrupt snapshots.
        }
      }
    }
  }
  walk(harnessDir);
  return out;
}
