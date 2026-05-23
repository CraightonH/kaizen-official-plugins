export interface ParsedManifest {
  name: string;
  description: string;
  tokens?: number;
}

export type ParseResult =
  | { ok: true; manifest: ParsedManifest; body: string }
  | { ok: false; error: string };

const HONORED_KEYS = new Set(["name", "description", "tokens"]);

export function parseFrontmatter(text: string): ParseResult {
  let src = text;
  if (src.charCodeAt(0) === 0xFEFF) src = src.slice(1);

  if (!src.startsWith("---\n") && src !== "---") {
    return { ok: false, error: "missing opening '---' delimiter" };
  }

  const afterOpen = src.slice(4); // past "---\n"
  // Closing delimiter: a line that is exactly "---", followed by either newline or EOF.
  const closeMatch = afterOpen.match(/^---(\n|$)/m);
  if (!closeMatch || closeMatch.index === undefined) {
    return { ok: false, error: "missing closing '---' delimiter" };
  }
  const headerText = afterOpen.slice(0, closeMatch.index);
  const body = afterOpen.slice(closeMatch.index + closeMatch[0].length);

  const raw: Record<string, string> = {};
  for (const line of headerText.split("\n")) {
    if (line.trim() === "") continue;
    const m = line.match(/^([A-Za-z_-][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!m) return { ok: false, error: `unparseable frontmatter line: ${JSON.stringify(line)}` };
    const key = m[1]!;
    let val = m[2] ?? "";
    if (val.includes("\n")) return { ok: false, error: `multi-line values not supported: ${key}` };
    // Strip balanced quotes.
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    raw[key] = val.trim();
  }

  if (!raw.name) return { ok: false, error: "missing required field: name" };
  if (!raw.description) return { ok: false, error: "missing required field: description" };

  const manifest: ParsedManifest = { name: raw.name, description: raw.description };
  if (raw.tokens) {
    const n = parseInt(raw.tokens, 10);
    if (Number.isFinite(n) && n > 0) manifest.tokens = n;
  }
  // Other keys silently ignored (HONORED_KEYS is informational here; we just don't read them).
  void HONORED_KEYS;

  return { ok: true, manifest, body };
}
