/**
 * True iff `name` matches `rule`. Rule is either an exact string, the
 * catch-all `*`, or a prefix glob of the form `<prefix>:*` where the `*` is
 * the entire final segment.
 */
export function matches(name: string, rule: string): boolean {
  if (typeof name !== "string") return false;
  if (typeof rule !== "string") return false;
  if (rule === "*") return true;
  if (rule.endsWith(":*")) {
    const prefix = rule.slice(0, -1);
    return name.startsWith(prefix);
  }
  return name === rule;
}

export function matchesAny(name: string, rules: ReadonlyArray<string>): boolean {
  for (const r of rules) {
    if (matches(name, r)) return true;
  }
  return false;
}

/**
 * Returns the "domain" glob for a tool name (everything up to and including
 * the last colon, then `*`). `mcp:github:list_issues` → `mcp:github:*`.
 * Returns null when the name has no `:` (no derivable domain).
 */
export function deriveDomain(name: string): string | null {
  if (typeof name !== "string" || name.length === 0) return null;
  const i = name.lastIndexOf(":");
  if (i < 0) return null;
  return name.slice(0, i + 1) + "*";
}
