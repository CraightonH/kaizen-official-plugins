import type { SessionsStoreService, SessionRecord } from "./store.ts";

export interface CommandsDeps {
  store: SessionsStoreService;
  emit: (event: string, payload: unknown) => Promise<unknown[]>;
  getActiveSessionId: () => string | null;
}

export interface ClearResult {
  from: string | null;
  to: string;
  alias: string | null;
}

export interface CommandsApi {
  clearSession(): Promise<ClearResult>;
  listSessions(opts: { includeChildren?: boolean }): Promise<SessionRecord[]>;
  resumeSession(opts: { id_or_alias: string }): Promise<{ id: string; alias: string | null }>;
  renameActiveSession(opts: { name: string }): Promise<{ id: string; alias: string }>;
  deleteSession(opts: { id: string; cascade?: boolean }): Promise<{ deleted: string; replacement?: string }>;
}

export function makeCommands(deps: CommandsDeps): CommandsApi {
  async function clearSession(): Promise<ClearResult> {
    const from = deps.getActiveSessionId();
    const next = await deps.store.create({});
    const alias = next.alias ?? null;
    await deps.emit("session:active-changed", { from, to: next.id, alias });
    await deps.emit("conversation:cleared", { from, to: next.id });
    return { from, to: next.id, alias };
  }

  async function listSessions(opts: { includeChildren?: boolean }): Promise<SessionRecord[]> {
    return deps.store.list({ includeChildren: opts.includeChildren ?? false });
  }

  async function resumeSession(opts: { id_or_alias: string }): Promise<{ id: string; alias: string | null }> {
    const token = opts.id_or_alias;
    if (!token) throw new Error("missing session id");
    let record: SessionRecord;
    if (await deps.store.exists(token)) {
      record = await deps.store.load(token);
    } else {
      const all = await deps.store.list({ includeChildren: true });
      const match = all.find((r) => r.alias === token);
      if (!match) throw new Error(`session not found: ${token}`);
      record = match;
    }
    const from = deps.getActiveSessionId();
    const alias = record.alias ?? null;
    await deps.emit("session:active-changed", { from, to: record.id, alias });
    await deps.emit("session:resumed", { id: record.id });
    return { id: record.id, alias };
  }

  async function renameActiveSession(opts: { name: string }): Promise<{ id: string; alias: string }> {
    if (!opts.name) throw new Error("name is required");
    const active = deps.getActiveSessionId();
    if (!active) throw new Error("no active session");
    const record = await deps.store.rename(active, opts.name);
    return { id: record.id, alias: record.alias! };
  }

  async function deleteSession(opts: { id: string; cascade?: boolean }): Promise<{ deleted: string; replacement?: string }> {
    if (!opts.id) throw new Error("missing session id");
    const cascade = opts.cascade ?? false;
    const active = deps.getActiveSessionId();
    if (opts.id !== active) {
      await deps.store.delete(opts.id, { cascade });
      return { deleted: opts.id };
    }
    const all = await deps.store.list({ includeChildren: true });
    const hasChildren = all.some((r) => r.id.startsWith(opts.id + "/"));
    if (hasChildren && !cascade) {
      throw new Error(`delete: session '${opts.id}' has children; pass cascade=true`);
    }
    const replacement = await deps.store.create({});
    try {
      await deps.store.delete(opts.id, { cascade });
    } catch (err) {
      try {
        await deps.store.delete(replacement.id, { cascade: true });
      } catch { /* ignore secondary failure */ }
      throw err;
    }
    await deps.emit("session:active-changed", { from: opts.id, to: replacement.id, alias: replacement.alias ?? null });
    return { deleted: opts.id, replacement: replacement.id };
  }

  return { clearSession, listSessions, resumeSession, renameActiveSession, deleteSession };
}
