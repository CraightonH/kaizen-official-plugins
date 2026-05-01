import { parse as parseYaml } from "yaml";

export type ParsedCommandFile =
  | {
      ok: true;
      description: string;
      usage?: string;
      argumentsRequired: boolean;
      body: string;
    }
  | { ok: false; reason: string };

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;

export function parseMarkdownCommandFile(path: string, raw: string): ParsedCommandFile {
  const m = FM_RE.exec(raw);
  if (!m) return { ok: false, reason: `${path}: missing YAML frontmatter` };
  const yamlText = m[1]!;
  const body = m[2]!;
  let fm: unknown;
  try {
    fm = parseYaml(yamlText);
  } catch (e) {
    return { ok: false, reason: `${path}: malformed YAML frontmatter: ${(e as Error).message}` };
  }
  if (!fm || typeof fm !== "object" || Array.isArray(fm)) {
    return { ok: false, reason: `${path}: frontmatter must be a YAML mapping` };
  }
  const obj = fm as Record<string, unknown>;
  const description = obj.description;
  if (typeof description !== "string" || description.length === 0) {
    return { ok: false, reason: `${path}: frontmatter.description (string) is required` };
  }
  const usage = typeof obj.usage === "string" ? obj.usage : undefined;
  let argumentsRequired = false;
  if (obj.arguments !== undefined) {
    if (!obj.arguments || typeof obj.arguments !== "object" || Array.isArray(obj.arguments)) {
      return { ok: false, reason: `${path}: frontmatter.arguments must be a mapping` };
    }
    const a = obj.arguments as Record<string, unknown>;
    if (a.required !== undefined) {
      if (typeof a.required !== "boolean") {
        return { ok: false, reason: `${path}: frontmatter.arguments.required must be boolean` };
      }
      argumentsRequired = a.required;
    }
  }
  return { ok: true, description, usage, argumentsRequired, body };
}
