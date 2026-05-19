import type { AxiomEntry } from "./public.d.ts";

function renderOne(a: AxiomEntry): string {
  const premiseLines = a.premises.map((p, i) => `  ${i + 1}. ${p}`).join("\n");
  return [
    `### ${a.id}`,
    `**Statement:** ${a.statement}`,
    `**Premises:**`,
    premiseLines,
    `**Reasoning:** ${a.reasoning}`,
  ].join("\n");
}

function groupByScope(entries: readonly AxiomEntry[]): Map<string, AxiomEntry[]> {
  const out = new Map<string, AxiomEntry[]>();
  for (const e of entries) {
    const arr = out.get(e.scope) ?? [];
    arr.push(e);
    out.set(e.scope, arr);
  }
  return out;
}

export function buildWorkspaceBlock(
  entries: readonly AxiomEntry[],
  byteCap: number,
): string | null {
  if (entries.length === 0) return null;

  // Drop oldest first until we fit. derivedAt ascending = oldest first.
  const sorted = [...entries].sort((a, b) => a.derivedAt - b.derivedAt);
  const keep = [...sorted];
  let truncated = false;

  const assemble = (kept: AxiomEntry[]): string => {
    const groups = groupByScope(kept);
    const body: string[] = [];
    for (const [scope, items] of groups) {
      body.push(`## ${scope}`);
      for (const e of items) body.push(renderOne(e));
    }
    if (truncated) body.push("_... [truncated]_");
    return [
      "<system-reminder>",
      "# Session axioms",
      "",
      body.join("\n\n"),
      "</system-reminder>",
    ].join("\n");
  };

  while (keep.length > 1 && Buffer.byteLength(assemble(keep), "utf8") > byteCap) {
    keep.shift();
    truncated = true;
  }
  return assemble(keep);
}
