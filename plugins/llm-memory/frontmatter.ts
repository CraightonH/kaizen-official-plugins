import type { MemoryEntry, MemoryType, MemoryScope } from "./public.d.ts";

const NAME_RE = /^[a-z0-9_-]{1,64}$/;
const VALID_TYPES = new Set<MemoryType>(["user", "feedback", "project", "reference"]);
const MAX_DESC = 200;

export function validateName(name: string): boolean {
  return NAME_RE.test(name);
}

interface Meta {
  name?: string;
  description?: string;
  type?: string;
  created?: string;
  updated?: string;
}

function parseFrontmatter(block: string): Meta | null {
  const meta: Meta = {};
  for (const raw of block.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line === "") continue;
    const idx = line.indexOf(":");
    if (idx === -1) return null;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    // Strip surrounding single or double quotes if present.
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key === "name" || key === "description" || key === "type" || key === "created" || key === "updated") {
      (meta as any)[key] = value;
    }
    // Unknown keys are ignored (forward-compat with hand-edited files).
  }
  return meta;
}

export function parseEntry(text: string, scope: MemoryScope): MemoryEntry | null {
  // Must start with `---\n` (allowing optional BOM).
  const stripped = text.replace(/^﻿/, "");
  if (!stripped.startsWith("---")) return null;
  // Find closing `\n---\n` or `\n---\r\n` after the opening line.
  const firstNl = stripped.indexOf("\n");
  if (firstNl === -1) return null;
  const close = stripped.indexOf("\n---", firstNl + 1);
  if (close === -1) return null;
  const block = stripped.slice(firstNl + 1, close);
  // Body starts after `\n---` + the line break that follows.
  let bodyStart = close + 4; // after `\n---`
  if (stripped[bodyStart] === "\r") bodyStart++;
  if (stripped[bodyStart] === "\n") bodyStart++;
  // Strip one additional leading blank line (common in hand-written and rendered files).
  if (stripped[bodyStart] === "\n") bodyStart++;
  const body = stripped.slice(bodyStart);

  const meta = parseFrontmatter(block);
  if (!meta) return null;
  if (!meta.name || !meta.description || !meta.type) return null;
  if (!validateName(meta.name)) return null;
  if (meta.description.length > MAX_DESC) return null;
  if (!VALID_TYPES.has(meta.type as MemoryType)) return null;

  return {
    name: meta.name,
    description: meta.description,
    type: meta.type as MemoryType,
    scope,
    body,
    created: meta.created,
    updated: meta.updated,
  };
}

export function renderEntry(entry: MemoryEntry): string {
  const lines: string[] = ["---"];
  lines.push(`name: ${entry.name}`);
  lines.push(`description: ${entry.description}`);
  lines.push(`type: ${entry.type}`);
  if (entry.created) lines.push(`created: ${entry.created}`);
  if (entry.updated) lines.push(`updated: ${entry.updated}`);
  lines.push("---");
  lines.push("");
  return lines.join("\n") + entry.body;
}
