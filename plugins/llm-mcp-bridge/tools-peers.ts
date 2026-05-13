import type { McpBridgeService, ServerInfo } from "./public.d.ts";
import type { ResolvedServerConfig } from "./config.ts";
import type { ToolSchema } from "llm-contracts/public";

export interface ToolHandlerLike {
  (args: any, ctx: { signal: AbortSignal; callId: string; log: (m: string) => void }): Promise<unknown>;
}
export interface ToolsRegistryLike {
  register(schema: ToolSchema, handler: ToolHandlerLike): () => void;
}

const EMPTY_OBJECT = { type: "object", properties: {}, additionalProperties: false } as const;

const SERVER_ARG = {
  type: "object",
  properties: { server: { type: "string", description: "MCP server name as configured." } },
  required: ["server"],
  additionalProperties: false,
} as const;

export function registerToolPeers(
  tools: ToolsRegistryLike,
  bridge: McpBridgeService & { reload(cfg: Map<string, ResolvedServerConfig>): Promise<{ added: string[]; removed: string[]; updated: string[] }> },
  reloadFromDisk: () => Promise<Map<string, ResolvedServerConfig>>,
): Array<() => void> {
  const offs: Array<() => void> = [];

  offs.push(tools.register(
    {
      name: "mcp:list",
      description: "List configured MCP servers and their connection status, transport, and tool/resource counts.",
      parameters: EMPTY_OBJECT as any,
    },
    async () => bridge.list() as ServerInfo[],
  ));

  offs.push(tools.register(
    {
      name: "mcp:reload",
      description: "Re-read the MCP server configuration from disk and apply the diff. Returns the added, removed, and updated server names.",
      parameters: EMPTY_OBJECT as any,
    },
    async () => {
      const cfg = await reloadFromDisk();
      return bridge.reload(cfg);
    },
  ));

  offs.push(tools.register(
    {
      name: "mcp:reconnect",
      description: "Force-reconnect a single MCP server. Useful when a server is in a degraded state.",
      parameters: SERVER_ARG as any,
    },
    async (args: any) => {
      await bridge.reconnect(String(args?.server ?? ""));
      return { ok: true };
    },
  ));

  offs.push(tools.register(
    {
      name: "mcp:disable",
      description: "Shut down a single MCP server until the next mcp:reload. Tools belonging to the server stop working.",
      parameters: SERVER_ARG as any,
    },
    async (args: any) => {
      await bridge.shutdown(String(args?.server ?? ""));
      return { ok: true };
    },
  ));

  return offs;
}
