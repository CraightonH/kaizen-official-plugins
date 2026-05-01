export interface ToolView { name: string; tags: string[]; }
export interface Filter { names?: string[]; tags?: string[]; }

export function matchesGlob(name: string, pattern: string): boolean {
  // Escape regex metacharacters except '*'; replace '*' with '.*'.
  const re = "^" + pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*") + "$";
  return new RegExp(re).test(name);
}

export function toolMatches(tool: ToolView, filter: Filter | undefined): boolean {
  if (!filter) return false;
  const namesHit = (filter.names ?? []).some((p) => matchesGlob(tool.name, p));
  const tagsHit = (filter.tags ?? []).some((t) => tool.tags.includes(t));
  if ((filter.names?.length ?? 0) === 0 && (filter.tags?.length ?? 0) === 0) return false;
  return namesHit || tagsHit;
}
