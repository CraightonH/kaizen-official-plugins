import type { ChatMessage } from "../public";

export interface SessionRecord {
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
}

export interface TurnHandle {
  readonly turnId: string;
  append(msg: ChatMessage): void;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  /**
   * Preserve the user message and any completed tool roundtrips; drop a trailing
   * assistant message whose toolCalls have no matching tool results.
   * If the post-trim buffer is empty, behave as rollback().
   */
  partialCommit(): Promise<void>;
}

export interface SessionsStoreService {
  create(opts: {
    parentSessionId?: string;
    childId?: string;
    alias?: string;
    agentName?: string;
    model?: string;
    metadata?: Record<string, unknown>;
  }): Promise<SessionRecord>;
  load(id: string): Promise<SessionRecord>;
  exists(id: string): Promise<boolean>;
  getMessages(id: string): Promise<ChatMessage[]>;
  beginTurn(id: string, turnId: string): TurnHandle;
  list(opts?: { parentSessionId?: string | null; includeChildren?: boolean; limit?: number }): Promise<SessionRecord[]>;
  /**
   * Rename a session by setting (or clearing) its alias. Persists the new
   * value to the snapshot atomically and appends a rename op to the index.
   * Pass `null` to clear the alias. Throws if `id` is unknown or if another
   * session under the same parent already uses `alias`.
   */
  rename(id: string, alias: string | null): Promise<SessionRecord>;
  delete(id: string, opts?: { cascade?: boolean }): Promise<void>;
  readEvents(id: string, opts?: { fromOffset?: number; limit?: number }): AsyncIterable<EventLogEntry>;
  internalAppendEvent?(sessionId: string, ts: number, event: string, payload: any): Promise<void>;
}

// EventLogEntry is part of the sessions:store contract surface (used by readEvents).
export interface EventLogEntry {
  offset: number;
  ts: number;
  event: string;
  payload: { turnId?: string; sessionId?: string } & Record<string, unknown>;
}

export const CONTRACT_ID = "sessions:store" as const;
export const DESCRIPTION = "Persistent session store — CRUD over conversation messages and metadata.";
