import type { SkillManifest } from "llm-events/public";

const PREAMBLE = "The following skills can be loaded on demand. Each has a name, description, and a rough token cost. Call the `load_skill` tool with `{ \"name\": \"<name>\" }` to pull a skill's full content into your context for the next turn. Only load a skill when it's clearly relevant — loading is not free.";

function singleLine(s: string): string {
  return s.replace(/\s*\n\s*/g, " ");
}

export function buildSkillsSection(list: SkillManifest[]): string {
  if (list.length === 0) return "";
  const lines: string[] = [];
  lines.push("## Available skills");
  lines.push("");
  lines.push(PREAMBLE);
  lines.push("");
  for (const m of list) {
    const tokens = typeof m.tokens === "number" ? m.tokens : 0;
    lines.push(`- ${m.name} (~${tokens} tokens): ${singleLine(m.description)}`);
  }
  return lines.join("\n");
}

export function applyInjection(request: { systemPrompt?: string }, list: SkillManifest[]): void {
  const section = buildSkillsSection(list);
  if (!section) return;
  const current = request.systemPrompt;
  if (current && current.length > 0) {
    request.systemPrompt = `${current}\n\n${section}`;
  } else {
    request.systemPrompt = section;
  }
}
