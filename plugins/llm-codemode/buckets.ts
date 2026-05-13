// Codemode-owned presentation policy for tool provenance.
//
// `llm-tools-registry` exposes `ToolSource` as an open shape (any `kind: string`
// plus arbitrary structured metadata). Codemode renders tools into a closed
// set of namespaces in the `kaizen.*` global it exposes to LLM-emitted code:
//
//   { kind: "local" }                -> kaizen.tools.<name>
//   { kind: "mcp", server: <s> }     -> kaizen.mcp.<normalizedServer>.<name>
//   { kind: "agent" }                -> kaizen.agents.<name>
//   { kind: "skill" }                -> kaizen.skills.<name>
//   { kind: "memory" }               -> kaizen.memory.<name>
//   anything else                    -> kaizen.tools.<name>   (fallback)
//
// The fallback to `tools` keeps the rendered `.d.ts` surface byte-stable for
// every existing kind. New provenance kinds can be introduced without
// touching codemode; if they later deserve their own namespace, add a new
// `CodemodeBucket` variant here and update the three call sites that switch
// on `bucket.kind` (assembler.ts, sandbox-host.ts, sandbox-entry.ts).
//
// This module is loaded both from the host (assembler.ts, sandbox-host.ts)
// and from the sandbox worker (sandbox-entry.ts). Keep it dependency-free at
// runtime; type-only imports from `llm-tools-registry/public` are fine
// because they're erased.

import type { ToolSource } from "llm-tools-registry/public";

export function normalizeServerName(name: string): string {
  let n = name.replace(/[^A-Za-z0-9_]/g, "_");
  if (/^[0-9]/.test(n)) n = `_${n}`;
  return n;
}

export type CodemodeBucket =
  | { kind: "tools" }
  | { kind: "mcp"; server: string }
  | { kind: "agents" }
  | { kind: "skills" }
  | { kind: "memory" };

export function bucketFor(source: ToolSource): CodemodeBucket {
  switch (source.kind) {
    case "local":
      return { kind: "tools" };
    case "mcp": {
      const raw = typeof (source as { server?: unknown }).server === "string"
        ? (source as { server: string }).server
        : "unknown";
      return { kind: "mcp", server: normalizeServerName(raw) };
    }
    case "agent":
      return { kind: "agents" };
    case "skill":
      return { kind: "skills" };
    case "memory":
      return { kind: "memory" };
    default:
      // Unknown provenance kinds land in the generic `tools` bucket so the
      // rendered surface stays byte-stable for known kinds and consumers can
      // introduce new kinds without breaking codemode.
      return { kind: "tools" };
  }
}
