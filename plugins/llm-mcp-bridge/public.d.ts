export type ServerStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "quarantined"
  | "disabled";

export interface ServerInfo {
  name: string;
  transport: "stdio" | "sse" | "http";
  status: ServerStatus;
  toolCount: number;
  resourceCount: number;
  promptCount: number;
  lastError?: string;
  connectedAt?: number;
  reconnectAttempts: number;
}

export interface McpBridgeService {
  list(): ServerInfo[];
  get(name: string): ServerInfo | undefined;
  reconnect(name: string): Promise<void>;
  reload(newConfig?: Map<string, import("./config.ts").ResolvedServerConfig>): Promise<{ added: string[]; removed: string[]; updated: string[] }>;
  shutdown(name: string): Promise<void>;
}
