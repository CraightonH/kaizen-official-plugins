import type { SkillsRegistryService, SkillManifest } from "llm-contracts/public";
import type { ScannedSkill } from "./scan.ts";
import { contentHash } from "./hash.ts";

export interface SnapshotEntry {
  hash: string;
  unregister: () => void;
}

export type RegistrarSnapshot = Map<string, SnapshotEntry>;

function estimateTokens(body: string): number {
  return Math.ceil(body.length / 4);
}

function buildManifest(s: ScannedSkill): SkillManifest {
  return {
    name: s.name,
    description: s.description,
    tokens: typeof s.tokens === "number" ? s.tokens : estimateTokens(s.body),
    baseDir: s.baseDir,
  };
}

function makeLoader(s: ScannedSkill): () => Promise<string> {
  // Capture the body by value. If the file is re-read at load time, stale
  // registrations could serve a different body than they advertised; the
  // rescan loop is responsible for catching content changes and re-registering.
  return async () => s.body;
}

export function reconcile(
  registry: SkillsRegistryService,
  current: ScannedSkill[],
  previous: RegistrarSnapshot,
): RegistrarSnapshot {
  const next: RegistrarSnapshot = new Map();
  const currentByName = new Map<string, ScannedSkill>();
  for (const s of current) currentByName.set(s.name, s);

  // First pass: handle adds and changes.
  for (const [name, s] of currentByName) {
    const hash = contentHash(s.body);
    const prev = previous.get(name);
    if (prev && prev.hash === hash) {
      // Unchanged — keep the existing registration.
      next.set(name, prev);
      continue;
    }
    if (prev) {
      // Changed — unregister the old, then register the new.
      try { prev.unregister(); } catch { /* idempotent */ }
    }
    const unreg = registry.register(buildManifest(s), makeLoader(s));
    next.set(name, { hash, unregister: unreg });
  }

  // Second pass: handle removals.
  for (const [name, entry] of previous) {
    if (!currentByName.has(name)) {
      try { entry.unregister(); } catch { /* idempotent */ }
    }
  }

  return next;
}
