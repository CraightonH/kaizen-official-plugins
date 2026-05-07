export const MCP_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

// Duplicated from plugins/llm-codemode/assembler.ts — keep in sync.
export function normalizeServerName(name: string): string {
  let n = name.replace(/[^A-Za-z0-9_]/g, "_");
  if (/^[0-9]/.test(n)) n = `_${n}`;
  return n;
}

/** Returns conflict groups: normalized names that map to 2+ raw server names. */
export function detectConflicts(serverNames: string[]): Array<{ normalized: string; servers: string[] }> {
  const groups = new Map<string, string[]>();
  for (const raw of serverNames) {
    const norm = normalizeServerName(raw);
    const arr = groups.get(norm);
    if (arr) arr.push(raw); else groups.set(norm, [raw]);
  }
  const conflicts: Array<{ normalized: string; servers: string[] }> = [];
  for (const [normalized, servers] of groups) {
    if (servers.length >= 2) conflicts.push({ normalized, servers });
  }
  return conflicts;
}

export function isValidServerName(name: string): boolean {
  return MCP_NAME_RE.test(name);
}

export function kaizenToolName(server: string, mcpToolName: string): string {
  return `mcp:${server}:${mcpToolName}`;
}

export function kaizenToolTags(server: string): string[] {
  return ["mcp", `mcp:${server}`];
}
