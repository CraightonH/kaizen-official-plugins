export const MCP_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

export function isValidServerName(name: string): boolean {
  return MCP_NAME_RE.test(name);
}

export function kaizenToolName(server: string, mcpToolName: string): string {
  return `mcp:${server}:${mcpToolName}`;
}

export function kaizenToolTags(server: string): string[] {
  return ["mcp", `mcp:${server}`];
}
