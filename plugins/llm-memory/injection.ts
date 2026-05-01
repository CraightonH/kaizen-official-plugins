import type { MemoryEntry } from "./public.d.ts";

export interface BuildBlockInput {
  projectIndex: string;
  globalIndex: string;
  projectEntries: MemoryEntry[];
  globalEntries: MemoryEntry[];
  projectPath: string;
  /** Per-layer cap for the index body (project and global each capped separately). */
  byteCap: number;
}

function truncateBody(text: string, cap: number): { text: string; truncated: boolean } {
  if (text.length <= cap) return { text, truncated: false };
  const marker = "\n... [truncated]";
  const room = Math.max(0, cap - marker.length);
  return { text: text.slice(0, room) + marker, truncated: true };
}

function catalogLines(entries: MemoryEntry[], scopeLabel: string): string[] {
  return entries
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => `- ${scopeLabel}:${e.name} — ${e.description}`);
}

export function buildMemoryBlock(input: BuildBlockInput): string | null {
  const projectHasIndex = input.projectIndex.trim().length > 0;
  const globalHasIndex = input.globalIndex.trim().length > 0;
  const hasProjectEntries = input.projectEntries.length > 0;
  const hasGlobalEntries = input.globalEntries.length > 0;
  if (!projectHasIndex && !globalHasIndex && !hasProjectEntries && !hasGlobalEntries) return null;

  const lines: string[] = [];
  lines.push("<system-reminder>");
  lines.push("# Persistent memory");
  lines.push("");
  lines.push("The following memory has been loaded automatically. Treat it as authoritative");
  lines.push("context about the user, their projects, and prior feedback.");
  lines.push("");

  let truncated = false;

  if (projectHasIndex || hasProjectEntries) {
    lines.push(`## Project memory (${input.projectPath})`);
    lines.push("");
    if (projectHasIndex) {
      const t = truncateBody(input.projectIndex, input.byteCap);
      truncated = truncated || t.truncated;
      lines.push(t.text);
      lines.push("");
    }
  }

  if (globalHasIndex || hasGlobalEntries) {
    lines.push("## Global memory (~/.kaizen/memory/)");
    lines.push("");
    if (globalHasIndex) {
      const t = truncateBody(input.globalIndex, input.byteCap);
      truncated = truncated || t.truncated;
      lines.push(t.text);
      lines.push("");
    }
  }

  if (hasProjectEntries || hasGlobalEntries) {
    lines.push("## Available memory entries (use the `memory_recall` tool to load any of these)");
    lines.push("");
    // Render catalog with oldest-first truncation: prefer entries with the most-recent `updated` if cap is hit.
    const totalCap = input.byteCap; // use one byteCap for the whole catalog
    const projLines = catalogLines(input.projectEntries, "project");
    const globLines = catalogLines(input.globalEntries, "global");
    let combined = [...projLines, ...globLines];
    let used = combined.join("\n").length;
    while (used > totalCap && combined.length > 0) {
      // Remove the first (oldest by name sort) entry to truncate.
      combined.shift();
      truncated = true;
      used = combined.join("\n").length;
    }
    if (combined.length > 0) lines.push(...combined);
    if (truncated) {
      lines.push("");
      lines.push("... [truncated]");
    }
  } else if (truncated) {
    lines.push("");
    lines.push("... [truncated]");
  }

  lines.push("</system-reminder>");
  return lines.join("\n");
}
