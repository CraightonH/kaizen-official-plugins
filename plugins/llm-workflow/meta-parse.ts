import type { WorkflowMeta } from "llm-contracts/public";
import { MetaParseError } from "./errors.ts";

const META_RE = /export\s+const\s+meta\s*=\s*\{/;

/**
 * Extract `export const meta = {...}` from a workflow script source.
 * `meta` MUST be a pure object literal — strings/numbers/booleans/null/arrays/objects only.
 * Any identifier reference, template interpolation, spread, or function call rejects.
 */
export function extractMeta(source: string): WorkflowMeta {
  const m = META_RE.exec(source);
  if (!m) throw new MetaParseError("no `export const meta = {...}` found");
  const openIdx = m.index + m[0].length - 1; // position of '{'
  const slice = extractBalanced(source, openIdx);
  if (slice == null) throw new MetaParseError("meta literal not balanced (missing closing brace)");

  // Disallow forbidden constructs anywhere in the slice.
  rejectDisallowed(slice);

  // Normalize JS-object literal to JSON: quote unquoted identifier keys, strip trailing commas.
  const normalized = normalizeToJson(slice);

  let parsed: unknown;
  try { parsed = JSON.parse(normalized); }
  catch (e) { throw new MetaParseError(`meta literal is not valid JSON-like: ${(e as Error).message}`); }

  if (!isPlainObject(parsed)) throw new MetaParseError("meta is not an object");

  const meta = parsed as Record<string, unknown>;
  if (typeof meta.name !== "string" || meta.name.length === 0) {
    throw new MetaParseError("meta.name must be a non-empty string");
  }
  if (typeof meta.description !== "string" || meta.description.length === 0) {
    throw new MetaParseError("meta.description must be a non-empty string");
  }
  return meta as unknown as WorkflowMeta;
}

function extractBalanced(src: string, openIdx: number): string | null {
  let depth = 0;
  let inStr: string | null = null;
  let escape = false;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i]!;
    if (escape) { escape = false; continue; }
    if (inStr) {
      if (c === "\\") { escape = true; continue; }
      if (c === inStr) { inStr = null; continue; }
      continue;
    }
    if (c === '"' || c === "'") { inStr = c; continue; }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(openIdx, i + 1);
    }
  }
  return null;
}

function rejectDisallowed(slice: string): void {
  // Backtick template literals — interpolation lives there.
  if (slice.includes("`")) throw new MetaParseError("template literals are not allowed in meta");
  // Spread.
  if (/\.\.\./.test(slice)) throw new MetaParseError("spread is not allowed in meta");
  // Function-call parens after an identifier (very conservative — disallow any `(` outside strings).
  const stripped = stripStrings(slice);
  if (/\(/.test(stripped)) throw new MetaParseError("function calls are not allowed in meta");
  // Identifier references as values: any identifier that isn't `true|false|null` and appears as a value.
  const valuePos = /:\s*([A-Za-z_$])/g;
  let match: RegExpExecArray | null;
  while ((match = valuePos.exec(stripped))) {
    const startAt = match.index + match[0].length - 1;
    const ident = stripped.slice(startAt).match(/^[A-Za-z_$][A-Za-z_$0-9]*/)?.[0] ?? "";
    if (ident !== "true" && ident !== "false" && ident !== "null") {
      throw new MetaParseError(`identifier reference '${ident}' is not allowed as a meta value`);
    }
  }
}

function stripStrings(s: string): string {
  let out = "";
  let inStr: string | null = null;
  let escape = false;
  for (const c of s) {
    if (escape) { escape = false; out += " "; continue; }
    if (inStr) {
      if (c === "\\") { escape = true; out += " "; continue; }
      if (c === inStr) { inStr = null; out += " "; continue; }
      out += " ";
      continue;
    }
    if (c === '"' || c === "'") { inStr = c; out += " "; continue; }
    out += c;
  }
  return out;
}

function normalizeToJson(slice: string): string {
  // 1) Replace single-quoted strings with double-quoted (preserve escapes).
  let out = "";
  let inStr: string | null = null;
  let escape = false;
  for (const c of slice) {
    if (escape) { out += c; escape = false; continue; }
    if (inStr) {
      if (c === "\\") { out += c; escape = true; continue; }
      if (c === inStr) {
        out += inStr === "'" ? '"' : c;
        inStr = null;
        continue;
      }
      // Convert any double-quote inside a single-quoted string to escaped form.
      if (inStr === "'" && c === '"') { out += '\\"'; continue; }
      out += c;
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = c;
      out += '"';
      continue;
    }
    out += c;
  }
  // 2) Quote unquoted identifier keys: `name:` → `"name":`.
  out = out.replace(/([\{,\s])([A-Za-z_$][A-Za-z_$0-9]*)\s*:/g, '$1"$2":');
  // 3) Strip trailing commas inside objects/arrays.
  out = out.replace(/,(\s*[\}\]])/g, "$1");
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
