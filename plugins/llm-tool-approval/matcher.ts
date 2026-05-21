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

export interface ParsedRule {
  name: string;
  pattern?: string;
}

/**
 * Splits a rule string into its name part and optional argument-pattern part.
 *
 *   "read"                       → { name: "read" }
 *   "bash(ls *)"                 → { name: "bash", pattern: "ls *" }
 *   "mcp:github:*(foo)"          → { name: "mcp:github:*", pattern: "foo" }
 *
 * Malformed rules return `null` — the caller should skip them and emit a
 * notice. v1 disallows `(` or `)` inside the pattern (no escapes, no nesting).
 */
export function parseRule(rule: string): ParsedRule | null {
  if (typeof rule !== "string" || rule.length === 0) return null;
  const open = rule.indexOf("(");
  if (open < 0) {
    if (rule.includes(")")) return null;
    return { name: rule };
  }
  if (open === 0) return null; // empty name
  if (!rule.endsWith(")")) return null; // trailing junk after pattern close
  const name = rule.slice(0, open);
  const pattern = rule.slice(open + 1, -1);
  if (pattern.length === 0) return null;
  if (pattern.includes("(") || pattern.includes(")")) return null;
  return { name, pattern };
}

/**
 * Compiles a shell-style glob pattern to an anchored RegExp.
 * Supported metacharacters: `*`, `?`, `[abc]`. All other regex metacharacters
 * are escaped. v1 does not support escapes.
 */
export function compilePattern(pattern: string): RegExp {
  let src = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      src += ".*";
    } else if (ch === "?") {
      src += ".";
    } else if (ch === "[") {
      const close = pattern.indexOf("]", i + 1);
      if (close < 0) {
        // Unclosed class — treat the rest as literal.
        src += escapeRegex(pattern.slice(i));
        i = pattern.length;
      } else {
        src += "[" + pattern.slice(i + 1, close) + "]";
        i = close;
      }
    } else {
      src += escapeRegex(ch);
    }
  }
  src += "$";
  return new RegExp(src);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
