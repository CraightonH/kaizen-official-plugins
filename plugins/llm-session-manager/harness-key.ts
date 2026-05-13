import { basename, dirname } from "node:path";

/**
 * Narrow shape of `ctx.harness` consumed by this plugin. Either field may be
 * present depending on how the harness was loaded (marketplace ref vs local
 * JSON). Both absent is valid and resolves to a stable "default" key.
 */
export interface HarnessIdentity {
  ref?: string;
  jsonPath?: string;
}

function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9_.-]/g, "_");
}

export function harnessKey(h: HarnessIdentity): string {
  if (h.ref) {
    const withoutVersion = h.ref.replace(/@[^/@]+$/, "");
    const derived = sanitize(withoutVersion.replace(/\//g, "_"));
    if (derived === "local" || derived.startsWith("local_")) {
      throw new Error(
        `Harness ref '${h.ref}' derives to a reserved local session key; ` +
          "rename the harness source or marketplace.",
      );
    }
    return derived;
  }

  if (h.jsonPath) {
    const base = basename(h.jsonPath);
    const name = base === "kaizen.json"
      ? basename(dirname(h.jsonPath))
      : base.replace(/\.json$/, "");
    return `local_${sanitize(name)}`;
  }

  return "default";
}
