import { mkdirSync, rmSync } from "node:fs";
import type { ChatMessage, SessionRecord, TurnHandle, SessionsStoreService, EventLogEntry } from "llm-contracts/public";
import { openEventsLog, type EventsLog } from "./events-log";
import { indexFile, harnessRoot, sessionPaths } from "./paths";
import { openIndex, type IndexEntry } from "./index-jsonl";
import { readSnapshot, type Snapshot, writeSnapshotAtomic } from "./snapshot";
import { isValidChildId, validateFullSessionId } from "./validation";


export interface StoreDeps {
  sessionsBase: string;
  harnessKey: string;
  pluginFingerprint: string[];
  now: () => number;
  newUuid: () => string;
  log: (msg: string) => void;
  emit: (event: string, payload: unknown) => Promise<unknown[]>;
}

interface OpenSession {
  record: SessionRecord;
  snapshot: Snapshot;
  events: EventsLog;
  openTurn?: { bufferedMessages: ChatMessage[] };
}

export function makeStore(deps: StoreDeps): SessionsStoreService {
  const root = harnessRoot(deps.sessionsBase, deps.harnessKey);
  mkdirSync(root, { recursive: true });
  const index = openIndex(indexFile(root), { harnessDir: root });
  const open = new Map<string, OpenSession>();

  function recordFromSnapshot(snap: Snapshot): SessionRecord {
    return {
      id: snap.id,
      harness: snap.harness,
      parentSessionId: snap.parentSessionId,
      alias: snap.alias,
      agentName: snap.agentName,
      model: snap.model,
      metadata: snap.metadata,
      createdAt: snap.createdAt,
      lastTurnAt: snap.lastTurnAt,
      pluginFingerprint: snap.pluginFingerprint,
    };
  }

  function loadIntoCache(id: string): OpenSession {
    const cached = open.get(id);
    if (cached) return cached;
    const paths = sessionPaths(root, id);
    const snapshot = readSnapshot(paths.snapshot);
    const sess: OpenSession = {
      record: recordFromSnapshot(snapshot),
      snapshot,
      events: openEventsLog(paths.events),
    };
    open.set(id, sess);
    return sess;
  }

  function indexRecordToSessionRecord(entry: IndexEntry): SessionRecord {
    const cached = open.get(entry.id);
    if (cached) return cached.record;
    return loadIntoCache(entry.id).record;
  }

  async function create(opts: Parameters<SessionsStoreService["create"]>[0]): Promise<SessionRecord> {
    const parentSessionId = opts.parentSessionId;
    let id: string;

    if (parentSessionId) {
      validateFullSessionId(parentSessionId);
      if (!opts.childId) throw new Error("create: childId is required for sub-sessions");
      if (!isValidChildId(opts.childId)) {
        throw new Error("create: childId must match ^[A-Za-z0-9_.-]+$ and cannot be '..'");
      }
      if (!index.get(parentSessionId)) {
        throw new Error(`create: parent session '${parentSessionId}' does not exist`);
      }
      id = `${parentSessionId}/${opts.childId}`;
      if (index.get(id)) throw new Error(`create: session '${id}' already exists`);
    } else {
      id = deps.newUuid();
      validateFullSessionId(id);
    }

    if (opts.alias) {
      const collision = index.list().find((entry) =>
        entry.alias === opts.alias && entry.parentSessionId === parentSessionId
      );
      if (collision) throw new Error(`create: alias '${opts.alias}' already in use under same parent`);
    }

    const now = deps.now();
    const snapshot: Snapshot = {
      schemaVersion: 1,
      id,
      harness: deps.harnessKey,
      parentSessionId,
      alias: opts.alias,
      agentName: opts.agentName,
      model: opts.model,
      metadata: opts.metadata ?? {},
      createdAt: now,
      lastTurnAt: undefined,
      pluginFingerprint: deps.pluginFingerprint.slice().sort(),
      messages: [],
    };

    const paths = sessionPaths(root, id);
    await writeSnapshotAtomic(paths.snapshot, paths.snapshotTmp, snapshot);
    const record = recordFromSnapshot(snapshot);
    await index.appendCreate({
      id,
      harness: snapshot.harness,
      parentSessionId,
      alias: opts.alias,
      agentName: opts.agentName,
      createdAt: now,
    });
    open.set(id, { record, snapshot, events: openEventsLog(paths.events) });
    await deps.emit("session:created", {
      id,
      harness: snapshot.harness,
      parentSessionId,
      alias: opts.alias,
      agentName: opts.agentName,
    });
    return record;
  }

  async function load(id: string): Promise<SessionRecord> {
    validateFullSessionId(id);
    if (!index.get(id)) throw new Error(`load: session '${id}' not found`);
    return loadIntoCache(id).record;
  }

  async function exists(id: string): Promise<boolean> {
    try {
      validateFullSessionId(id);
    } catch {
      return false;
    }
    return Boolean(index.get(id));
  }

  async function getMessages(id: string): Promise<ChatMessage[]> {
    validateFullSessionId(id);
    const sess = loadIntoCache(id);
    const base = sess.snapshot.messages;
    if (sess.openTurn) return [...base, ...sess.openTurn.bufferedMessages];
    return base.slice();
  }

  function beginTurn(id: string, turnId: string): TurnHandle {
    validateFullSessionId(id);
    if (!index.get(id)) throw new Error(`beginTurn: session '${id}' not found`);
    const sess = loadIntoCache(id);
    if (sess.openTurn) throw new Error(`beginTurn: session '${id}' already has an open turn`);

    const bufferedMessages: ChatMessage[] = [];
    let closed = false;
    let committed = false;

    async function writeBufferedMessages(messagesToWrite: ChatMessage[]) {
      const next: Snapshot = {
        ...sess.snapshot,
        messages: [...sess.snapshot.messages, ...messagesToWrite],
        lastTurnAt: deps.now(),
      };
      const paths = sessionPaths(root, id);
      await sess.events.flush();
      await writeSnapshotAtomic(paths.snapshot, paths.snapshotTmp, next);
      sess.snapshot = next;
      sess.record = recordFromSnapshot(next);
      sess.openTurn = undefined;
      try {
        await index.appendUpdate({ id, lastTurnAt: next.lastTurnAt! });
      } catch (err) {
        deps.log(`sessions: index update failed for ${id}: ${String((err as any)?.message ?? err)}`);
      }
    }

    const handle: TurnHandle = {
      turnId,
      append(message) {
        if (closed) throw new Error("turnHandle: append after commit/rollback");
        bufferedMessages.push(message);
      },
      async commit() {
        if (closed) return;
        await writeBufferedMessages(bufferedMessages);
        closed = true;
        committed = true;
      },
      async rollback() {
        if (committed) return;
        if (closed) return;
        sess.openTurn = undefined;
        closed = true;
      },
      async partialCommit() {
        if (closed) return;
        const trimmed = [...bufferedMessages];
        const last = trimmed[trimmed.length - 1];
        if (last && last.role === "assistant" && Array.isArray(last.toolCalls) && last.toolCalls.length > 0) {
          trimmed.pop();
        }
        if (trimmed.length === 0) {
          sess.openTurn = undefined;
          closed = true;
          return;
        }
        await writeBufferedMessages(trimmed);
        closed = true;
        committed = true;
      },
    };
    sess.openTurn = { bufferedMessages };
    return handle;
  }

  async function list(opts?: { parentSessionId?: string | null; includeChildren?: boolean; limit?: number }): Promise<SessionRecord[]> {
    const filtered = index.list().filter((entry) => {
      if (opts?.includeChildren) return true;
      if (opts?.parentSessionId === undefined || opts?.parentSessionId === null) {
        return entry.parentSessionId === undefined;
      }
      return entry.parentSessionId === opts.parentSessionId;
    });
    return filtered.slice(0, opts?.limit ?? filtered.length).map(indexRecordToSessionRecord);
  }

  async function rename(id: string, alias: string | null): Promise<SessionRecord> {
    validateFullSessionId(id);
    const entry = index.get(id);
    if (!entry) throw new Error(`rename: session '${id}' not found`);

    const trimmed = typeof alias === "string" ? alias.trim() : null;
    const nextAlias: string | undefined = trimmed ? trimmed : undefined;

    if (nextAlias) {
      const collision = index.list().find((e) =>
        e.id !== id && e.alias === nextAlias && e.parentSessionId === entry.parentSessionId
      );
      if (collision) throw new Error(`rename: alias '${nextAlias}' already in use under same parent`);
    }

    const sess = loadIntoCache(id);
    const next: Snapshot = { ...sess.snapshot, alias: nextAlias };
    const paths = sessionPaths(root, id);
    await writeSnapshotAtomic(paths.snapshot, paths.snapshotTmp, next);
    sess.snapshot = next;
    sess.record = recordFromSnapshot(next);
    await index.appendRename({ id, alias: nextAlias });
    await deps.emit("session:renamed", { id, alias: nextAlias ?? null });
    return sess.record;
  }

  async function deleteSession(id: string, opts?: { cascade?: boolean }): Promise<void> {
    validateFullSessionId(id);
    if (!index.get(id)) throw new Error(`delete: session '${id}' not found`);
    const descendants = index.list().filter((entry) => entry.id.startsWith(id + "/"));
    if (descendants.length > 0 && !opts?.cascade) {
      throw new Error(`delete: session '${id}' has children; pass cascade: true`);
    }
    rmSync(sessionPaths(root, id).dir, { recursive: true, force: true });
    open.delete(id);
    if (opts?.cascade) {
      for (const key of Array.from(open.keys())) {
        if (key.startsWith(id + "/")) open.delete(key);
      }
    }
    await index.appendDelete({ id, cascade: !!opts?.cascade });
    await deps.emit("session:deleted", { id, cascade: !!opts?.cascade });
  }

  async function* readEvents(id: string, opts?: { fromOffset?: number; limit?: number }): AsyncIterable<EventLogEntry> {
    validateFullSessionId(id);
    if (!index.get(id)) throw new Error(`readEvents: session '${id}' not found`);
    yield* loadIntoCache(id).events.readEvents(opts);
  }

  async function internalAppendEvent(sessionId: string, ts: number, event: string, payload: any): Promise<void> {
    if (!index.get(sessionId)) return;
    const sess = loadIntoCache(sessionId);
    await sess.events.append({ ts, event, payload });
    if (event === "turn:end") await sess.events.flush();
  }

  return {
    create,
    load,
    exists,
    getMessages,
    beginTurn,
    list,
    rename,
    delete: deleteSession,
    readEvents,
    internalAppendEvent,
  };
}
