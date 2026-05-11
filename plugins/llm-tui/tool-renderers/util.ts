export const MAX_PREVIEW = 80;

// Heuristic: when args is an object, these keys (in priority order) usually
// hold the "interesting" payload — show their value rather than the whole
// object. Mirrors what Claude Code does for its built-in tools.
export const PRIMARY_ARG_KEYS = [
  "command",     // Bash
  "code",        // execute_typescript / shell-eval
  "file_path", "filePath", "path",   // Read/Edit/Write/Glob
  "pattern",     // Grep/Glob
  "query",       // Search-like tools
  "url",         // Fetch
  "prompt",      // Sub-agent style tools
  "text",
  "message",
  "name",
];

export function compactWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}

// Walk an object: prefer a known primary key with a non-empty string value;
// fall back to single-key value; fall back to compact "key=value" pairs.
// Returns a single-line string suitable for further truncation.
export function pickPrimary(obj: Record<string, unknown>, primaryKeys: string[]): string {
  for (const k of primaryKeys) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) return compactWhitespace(v);
  }

  const keys = Object.keys(obj);
  if (keys.length === 1) {
    const v = obj[keys[0]!];
    if (typeof v === "string") return compactWhitespace(v);
    let vs: string;
    try { vs = JSON.stringify(v); } catch { vs = String(v); }
    return compactWhitespace(vs);
  }

  const parts = keys.map((k) => {
    const v = obj[k];
    const vs = typeof v === "string" ? v : (() => {
      try { return JSON.stringify(v); } catch { return String(v); }
    })();
    return `${k}=${vs}`;
  });
  return compactWhitespace(parts.join(", "));
}

// Render args as a short, human-readable string. Tries to surface the
// "primary" argument value (e.g. the command for Bash, the file path for
// Read) rather than dumping the full JSON object, which is unreadable
// at a glance and dominated by braces and quotes.
export function defaultCollapsedSummary(args: unknown): string {
  if (args == null) return "";
  if (typeof args === "string") return truncate(compactWhitespace(args), MAX_PREVIEW);
  if (typeof args !== "object") return truncate(String(args), MAX_PREVIEW);
  return truncate(pickPrimary(args as Record<string, unknown>, PRIMARY_ARG_KEYS), MAX_PREVIEW);
}
