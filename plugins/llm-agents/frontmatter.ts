import type { AgentManifest } from "llm-events/public";

export interface InternalAgentManifest extends AgentManifest {
  modelOverride?: string;
  sourcePath: string;
  scope: "user" | "project";
}

export type ParseResult =
  | { ok: true; manifest: Omit<InternalAgentManifest, "sourcePath" | "scope"> }
  | { ok: false; error: string };

const NAME_RE = /^[a-z0-9_-]+$/;

export function parseAgentFile(text: string, sourcePath: string): ParseResult {
  // Frontmatter delimiter: file MUST start with "---\n"
  if (!text.startsWith("---\n")) {
    return { ok: false, error: `${sourcePath}: missing YAML frontmatter (file must begin with '---')` };
  }
  const rest = text.slice(4);
  const endIdx = rest.indexOf("\n---");
  if (endIdx === -1) {
    return { ok: false, error: `${sourcePath}: unterminated frontmatter (no closing '---')` };
  }
  const yaml = rest.slice(0, endIdx);
  // Body starts after "\n---" and the next newline.
  let bodyStart = endIdx + 4; // past "\n---"
  if (rest[bodyStart] === "\r") bodyStart++;
  if (rest[bodyStart] === "\n") bodyStart++;
  const body = rest.slice(bodyStart);

  let fields: Record<string, unknown>;
  try { fields = parseStrictYaml(yaml); }
  catch (err) { return { ok: false, error: `${sourcePath}: ${(err as Error).message}` }; }

  const name = fields.name;
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    return { ok: false, error: `${sourcePath}: 'name' is required and must match [a-z0-9_-]+` };
  }
  const description = fields.description;
  if (typeof description !== "string" || description.trim().length === 0) {
    return { ok: false, error: `${sourcePath}: 'description' is required and must be a non-empty string` };
  }

  const toolNames = fields.tools;
  const tags = fields.tags;
  if (toolNames !== undefined && !isStringArray(toolNames)) {
    return { ok: false, error: `${sourcePath}: 'tools' must be an array of strings` };
  }
  if (tags !== undefined && !isStringArray(tags)) {
    return { ok: false, error: `${sourcePath}: 'tags' must be an array of strings` };
  }
  const modelOverride = fields.model;
  if (modelOverride !== undefined && typeof modelOverride !== "string") {
    return { ok: false, error: `${sourcePath}: 'model' must be a string` };
  }

  const toolFilter = (toolNames || tags)
    ? { names: toolNames as string[] | undefined, tags: tags as string[] | undefined }
    : undefined;

  return {
    ok: true,
    manifest: {
      name,
      description: description.trim(),
      systemPrompt: body,
      toolFilter,
      modelOverride: modelOverride as string | undefined,
    },
  };
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/**
 * Strict YAML subset parser:
 *   key: scalar         (unquoted, "double", or 'single')
 *   key: integer
 *   key: ["a", "b"]     (flow array of strings)
 *   key: >-             (folded block scalar; following indented lines fold with single spaces)
 *     line one
 *     line two
 * Comments (# ...) on a line of their own are ignored. Anything else throws.
 */
function parseStrictYaml(src: string): Record<string, unknown> {
  const lines = src.split("\n");
  const out: Record<string, unknown> = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "" || line.trim().startsWith("#")) { i++; continue; }
    const m = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!m) throw new Error(`unparseable line: ${JSON.stringify(line)}`);
    const key = m[1]!;
    const rhs = (m[2] ?? "").trim();
    if (rhs === ">-" || rhs === ">") {
      // Folded block scalar: take following indented lines.
      const collected: string[] = [];
      i++;
      while (i < lines.length) {
        const next = lines[i] ?? "";
        if (next.length === 0) { collected.push(""); i++; continue; }
        if (!/^\s+/.test(next)) break;
        collected.push(next.replace(/^\s+/, ""));
        i++;
      }
      out[key] = collected.join(" ").replace(/\s+/g, " ").trim();
      continue;
    }
    if (rhs.startsWith("[")) {
      // Flow array: must close on same line.
      if (!rhs.endsWith("]")) throw new Error(`unterminated flow array at key '${key}'`);
      const inner = rhs.slice(1, -1).trim();
      if (inner.length === 0) { out[key] = []; i++; continue; }
      const items: string[] = [];
      // Split on commas not inside quotes.
      let buf = "";
      let inSingle = false, inDouble = false;
      for (const c of inner) {
        if (c === "'" && !inDouble) inSingle = !inSingle;
        else if (c === '"' && !inSingle) inDouble = !inDouble;
        if (c === "," && !inSingle && !inDouble) { items.push(buf.trim()); buf = ""; continue; }
        buf += c;
      }
      if (buf.trim().length > 0) items.push(buf.trim());
      out[key] = items.map(unquoteScalar);
      i++;
      continue;
    }
    out[key] = parseScalar(rhs);
    i++;
  }
  return out;
}

function unquoteScalar(s: string): string {
  const v = parseScalar(s);
  if (typeof v !== "string") throw new Error(`array items must be strings, got ${typeof v}: ${s}`);
  return v;
}

function parseScalar(rhs: string): string | number {
  if (rhs.length === 0) return "";
  if (rhs.startsWith('"') && rhs.endsWith('"')) return rhs.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"');
  if (rhs.startsWith("'") && rhs.endsWith("'")) return rhs.slice(1, -1);
  if (/^-?\d+$/.test(rhs)) return Number(rhs);
  return rhs; // bare string
}
