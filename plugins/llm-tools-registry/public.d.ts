// llm-tools-registry public surface.
// Spec 0 owns ToolSchema, ToolCall, ChatMessage, and the CANCEL_TOOL runtime value.
// Import CANCEL_TOOL from `llm-events`.
// This plugin owns ToolsRegistryService, ToolHandler, ToolExecutionContext,
// ToolSource, and ToolRegistration.

export type {
  ToolSchema,
  ToolCall,
  ChatMessage,
} from "llm-events/public";

export type {
  ToolsRegistryService,
  ToolHandler,
  ToolExecutionContext,
} from "./registry";

import type { ToolSchema as _ToolSchema } from "llm-events/public";
import type { ToolHandler as _ToolHandler } from "./registry";

export type ToolSource =
  | { kind: "local" }
  | { kind: "mcp"; server: string }
  | { kind: "agent" }
  | { kind: "skill" }
  | { kind: "memory" };

export interface ToolRegistration {
  schema: _ToolSchema;
  handler: _ToolHandler;
  source: ToolSource;
}
