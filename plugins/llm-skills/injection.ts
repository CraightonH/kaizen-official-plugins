import type { SkillManifest } from "llm-events/public";

const PREAMBLE = "The following skills can be loaded on demand. Each has a name, description, and a rough token cost. Call the `load_skill` tool with `{ \"name\": \"<name>\" }` to pull a skill's full content into your context for the next turn. Only load a skill when it's clearly relevant — loading is not free.";

function singleLine(s: string): string {
  return s.replace(/\s*\n\s*/g, " ");
}

/**
 * Renders the skills list as a block suitable for a prompt:system section.
 * The section title ("## Available skills") is provided by the section registration,
 * so this block intentionally does NOT include a heading.
 *
 * Returns "" when the list is empty — the system-prompt registry drops empty sections.
 */
export function buildSkillsBlock(list: SkillManifest[]): string {
  if (list.length === 0) return "";
  const lines: string[] = [];
  lines.push(PREAMBLE);
  lines.push("");
  for (const m of list) {
    const tokens = typeof m.tokens === "number" ? m.tokens : 0;
    lines.push(`- ${m.name} (~${tokens} tokens): ${singleLine(m.description)}`);
  }
  return lines.join("\n");
}
