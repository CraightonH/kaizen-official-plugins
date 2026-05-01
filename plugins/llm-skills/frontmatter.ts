export interface ParsedManifest {
  name: string;
  description: string;
  tokens?: number;
}

export type ParseResult =
  | { ok: true; manifest: ParsedManifest; body: string }
  | { ok: false; error: string };

const ALLOWED_KEYS = new Set(["name", "description", "tokens"]);

function stripQuotes(v: string): string {
  if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

export function parseFrontmatter(text: string): ParseResult {
  // Normalise line endings.
  const normalised = text.replace(/\r\n/g, "\n");
  if (!normalised.startsWith("---\n")) {
    return { ok: false, error: "missing opening frontmatter delimiter (---)" };
  }
  const rest = normalised.slice(4);
  const closeIdx = rest.indexOf("\n---\n");
  // Allow file that ends with `---` and no trailing newline.
  let blockEnd: number;
  let bodyStart: number;
  if (closeIdx >= 0) {
    blockEnd = closeIdx;
    bodyStart = closeIdx + 5;
  } else if (rest.endsWith("\n---")) {
    blockEnd = rest.length - 4;
    bodyStart = rest.length;
  } else {
    return { ok: false, error: "missing closing frontmatter delimiter (---)" };
  }
  const block = rest.slice(0, blockEnd);
  const body = rest.slice(bodyStart);

  const fields: Record<string, string | number> = {};
  for (const rawLine of block.split("\n")) {
    const line = rawLine.trimEnd();
    if (line === "" || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon < 0) {
      return { ok: false, error: `invalid frontmatter line: ${rawLine}` };
    }
    const key = line.slice(0, colon).trim();
    const value = stripQuotes(line.slice(colon + 1).trim());
    if (!ALLOWED_KEYS.has(key)) continue;
    if (value.includes("\n")) {
      return { ok: false, error: `frontmatter value for ${key} must be single-line` };
    }
    if (key === "tokens") {
      if (!/^\d+$/.test(value)) {
        return { ok: false, error: `tokens must be a non-negative integer, got: ${value}` };
      }
      fields.tokens = parseInt(value, 10);
    } else {
      fields[key] = value;
    }
  }

  const name = fields.name as string | undefined;
  const description = fields.description as string | undefined;
  if (!name) return { ok: false, error: "frontmatter missing required field: name" };
  if (!description) return { ok: false, error: "frontmatter missing required field: description" };

  const manifest: ParsedManifest = { name, description };
  if (typeof fields.tokens === "number") manifest.tokens = fields.tokens;

  return { ok: true, manifest, body };
}
