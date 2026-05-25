// Contract types are now canonical in llm-contracts. Re-exported here for back-compat.
export type { McpBridgeService, ServerInfo, ServerStatus } from "llm-contracts/public";

import type { ServerConfig } from "./servers.ts";

// Plugin-private config type. The `servers` map is keyed by server name and
// validated by `CONFIG_SCHEMA` in `config.ts`. Entries pass through
// `resolveServers` (env interpolation, transport inference, defaults) before
// reaching the lifecycle layer.
export interface McpBridgeConfig {
  servers: Record<string, ServerConfig>;
}
