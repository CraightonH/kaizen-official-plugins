import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { AxiomEntry, AxiomsRegistryService } from "./public.d.ts";
import { validateAxiomId, validateAxiomEntry, AxiomValidationError } from "./schema.ts";
import { sessionFilePath } from "./paths.ts";

export interface MakeStoreOpts {
  axiomsDir: string;
  now?: () => number;
  log?: (msg: string) => void;
}

interface DiskShape {
  version: 1;
  sessionId: string;
  axioms: AxiomEntry[];
}

export function makeStore(opts: MakeStoreOpts): AxiomsRegistryService & { swapSession(id: string | null): Promise<void> } {
  const dir = opts.axiomsDir;
  const now = opts.now ?? (() => Date.now());
  const log = opts.log ?? (() => {});
  let activeSession: string | null = null;
  let entries: Map<string, AxiomEntry> = new Map();
  const listeners = new Set<() => void>();

  if (!existsSync(dir)) {
    try { mkdirSync(dir, { recursive: true }); } catch {}
  }

  const fire = () => {
    for (const cb of listeners) {
      try { cb(); } catch (e) { log(`onChange listener threw: ${(e as Error).message}`); }
    }
  };

  const requireSession = (): string => {
    if (!activeSession) {
      throw new Error("no_active_session: call swapSession() before mutating");
    }
    return activeSession;
  };

  const persist = async (): Promise<void> => {
    const sid = requireSession();
    const target = sessionFilePath(dir, sid);
    const payload: DiskShape = {
      version: 1,
      sessionId: sid,
      axioms: Array.from(entries.values()),
    };
    const tmp = `${target}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
    await writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
    try {
      await rename(tmp, target);
    } catch (err) {
      try { await unlink(tmp); } catch {}
      throw err;
    }
  };

  const service: AxiomsRegistryService & { swapSession(id: string | null): Promise<void> } = {
    list() {
      return Array.from(entries.values());
    },
    get(id) {
      return entries.get(id) ?? null;
    },
    async record(input) {
      requireSession();
      validateAxiomEntry(input);
      if (entries.has(input.id)) {
        throw new AxiomValidationError("axiom_exists", `axiom_exists: axiom "${input.id}" already exists`);
      }
      const full: AxiomEntry = { ...input, derivedAt: now() };
      const prev = new Map(entries);
      entries.set(full.id, full);
      try {
        await persist();
      } catch (e) {
        entries = prev;
        throw e;
      }
      fire();
      return full;
    },
    async amend(id, patch) {
      requireSession();
      validateAxiomId(id);
      const existing = entries.get(id);
      if (!existing) throw new AxiomValidationError("axiom_not_found", `axiom_not_found: axiom "${id}" not found`);
      const merged: AxiomEntry = {
        ...existing,
        ...("statement" in patch ? { statement: patch.statement ?? existing.statement } : {}),
        ...("premises" in patch ? { premises: patch.premises ?? existing.premises } : {}),
        ...("reasoning" in patch ? { reasoning: patch.reasoning ?? existing.reasoning } : {}),
        ...("scope" in patch ? { scope: patch.scope ?? existing.scope } : {}),
        amendedAt: now(),
      };
      validateAxiomEntry(merged);
      const prev = new Map(entries);
      entries.set(id, merged);
      try {
        await persist();
      } catch (e) {
        entries = prev;
        throw e;
      }
      fire();
      return merged;
    },
    async drop(id, reason) {
      requireSession();
      validateAxiomId(id);
      if (!entries.has(id)) {
        throw new AxiomValidationError("axiom_not_found", `axiom_not_found: axiom "${id}" not found`);
      }
      if (typeof reason !== "string" || reason.length === 0 || reason.length > 500) {
        throw new AxiomValidationError("invalid_reason", "drop reason must be a non-empty string ≤ 500 chars");
      }
      const prev = new Map(entries);
      entries.delete(id);
      try {
        await persist();
      } catch (e) {
        entries = prev;
        throw e;
      }
      fire();
      return true;
    },
    async clear() {
      if (!activeSession) return;
      const prev = new Map(entries);
      entries = new Map();
      try {
        await persist();
      } catch (e) {
        entries = prev;
        throw e;
      }
      fire();
    },
    onChange(cb) {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
    async swapSession(sessionId) {
      // Build the next map in a local before swapping, so readers calling
      // list()/get() during the await window see the old set, not an empty
      // intermediate. The swap itself is synchronous.
      const next = new Map<string, AxiomEntry>();
      if (sessionId) {
        const f = sessionFilePath(dir, sessionId);
        if (existsSync(f)) {
          try {
            const raw = await readFile(f, "utf8");
            const parsed = JSON.parse(raw) as DiskShape;
            if (parsed && Array.isArray(parsed.axioms)) {
              for (const e of parsed.axioms) {
                if (typeof e?.id === "string") next.set(e.id, e);
              }
            }
          } catch (e) {
            log(`swapSession: failed to load ${f}: ${(e as Error).message}; starting empty`);
          }
        }
      }
      activeSession = sessionId;
      entries = next;
      fire();
    },
  };

  return service;
}
