// Single source of truth for how `ToolRegistration`s become the nested
// `kaizen.{tools,mcp,agents,skills,memory}` namespace tree.
//
// Used by both the host (to expose direct `(args) => invoke(name, args)`
// functions in tests) and the sandbox worker (to expose `(args) => post a
// tool-invoke message` proxies inside user code). Keeping the shape policy in
// one module means host-side tests that lock the tree layout also lock the
// in-sandbox `kaizen` global the LLM sees.
//
// This module is loaded by both the host and the sandbox worker. Keep it
// dependency-free at runtime; type-only imports are fine.

import type { ToolSource } from "llm-tools-registry/public";
import { bucketFor } from "./buckets.ts";

export interface RegistrationLike {
  name: string;
  source: ToolSource;
}

export interface KaizenTree<T> {
  tools?: Record<string, T>;
  mcp?: Record<string, Record<string, T>>;
  agents?: Record<string, T>;
  skills?: Record<string, T>;
  memory?: Record<string, T>;
}

/**
 * Build the nested kaizen namespace tree from a flat list of registrations.
 * The `leaf` factory turns each registration's name into the value placed at
 * its node — typically an invoke function. Empty namespaces are omitted.
 */
export function buildKaizenTree<T>(
  registrations: ReadonlyArray<RegistrationLike>,
  leaf: (name: string) => T,
): KaizenTree<T> {
  const out: KaizenTree<T> = {};
  const ensure = <K extends "tools" | "agents" | "skills" | "memory">(k: K): Record<string, T> => {
    if (!out[k]) out[k] = {} as Record<string, T>;
    return out[k] as Record<string, T>;
  };
  const ensureMcp = (): Record<string, Record<string, T>> => {
    if (!out.mcp) out.mcp = {};
    return out.mcp;
  };

  for (const r of registrations) {
    const bucket = bucketFor(r.source);
    switch (bucket.kind) {
      case "tools":
        ensure("tools")[r.name] = leaf(r.name);
        break;
      case "mcp": {
        const ns = ensureMcp();
        if (!ns[bucket.server]) ns[bucket.server] = {};
        ns[bucket.server]![r.name] = leaf(r.name);
        break;
      }
      case "agents":
        ensure("agents")[r.name] = leaf(r.name);
        break;
      case "skills":
        ensure("skills")[r.name] = leaf(r.name);
        break;
      case "memory":
        ensure("memory")[r.name] = leaf(r.name);
        break;
    }
  }
  return out;
}
