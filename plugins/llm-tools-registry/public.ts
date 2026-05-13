// llm-tools-registry public surface.
// ToolsRegistryService, ToolHandler, ToolExecutionContext, and CANCEL_TOOL
// are now canonical in llm-contracts/public. Re-exported here for backwards
// compatibility.
// This plugin owns ToolSource and ToolRegistration.

export type {
  ToolSchema,
  ToolCall,
  ChatMessage,
} from "llm-contracts/public";

export type {
  ToolsRegistryService,
  ToolHandler,
  ToolExecutionContext,
} from "llm-contracts/public";

export { CANCEL_TOOL } from "llm-contracts/public";

import type { ToolSchema as _ToolSchema } from "llm-contracts/public";
import type { ToolHandler as _ToolHandler } from "llm-contracts/public";

// ToolSource is open-shaped. `kind` is a freeform string so that new
// provenance kinds can be introduced without editing this file. Well-known
// kinds and their structured metadata:
//
//   { kind: "local" }                       — registered directly by a plugin
//   { kind: "mcp"; server: string }         — brokered from an MCP server
//   { kind: "agent" }                       — agent dispatch tool
//   { kind: "skill" }                       — skill dispatch tool
//   { kind: "memory" }                      — memory recall/save tool
//
// Consumers that bucket tools for presentation (e.g. llm-codemode) should
// define their own closed bucket type and a mapping function with a
// well-defined fallback for unknown kinds. The registry itself stores
// `source` opaquely and does not pattern-match on `kind`.
export interface ToolSource {
  kind: string;
  [k: string]: unknown;
}

export interface ToolRegistration {
  schema: _ToolSchema;
  handler: _ToolHandler;
  source: ToolSource;
}
