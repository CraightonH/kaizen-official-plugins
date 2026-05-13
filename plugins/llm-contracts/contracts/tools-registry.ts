import type { ToolSchema } from "../public";

export interface ToolExecutionContext {
  signal: AbortSignal;
  callId: string;
  turnId?: string;
  sessionId?: string;
  log: (msg: string) => void;
}

export type ToolHandler = (args: unknown, ctx: ToolExecutionContext) => Promise<unknown>;

export interface ToolsRegistryService {
  register(schema: ToolSchema, handler: ToolHandler): () => void;
  registerWith(reg: { schema: ToolSchema; handler: ToolHandler; source: { kind: string; [k: string]: unknown } }): () => void;
  list(filter?: { tags?: string[]; names?: string[]; sources?: string[] }): ToolSchema[];
  listRegistrations(filter?: { tags?: string[]; names?: string[]; sources?: string[] }): Array<{ schema: ToolSchema; handler: ToolHandler; source: { kind: string; [k: string]: unknown } }>;
  invoke(name: string, args: unknown, ctx: ToolExecutionContext): Promise<unknown>;
}

/**
 * Cancellation sentinel for `tool:before-execute` subscribers. Set
 * `payload.args = CANCEL_TOOL` to abort the tool call. The registry
 * surfaces a cancelled invocation as a `tool:error` with message
 * `"cancelled by subscriber"` and an error whose `name` is `"AbortError"`.
 *
 * The underlying symbol is well-known (`Symbol.for("kaizen.cancel")`), so
 * any plugin can produce it inline without importing — both forms are equal.
 */
export const CANCEL_TOOL: unique symbol = Symbol.for("kaizen.cancel") as any;

export const CONTRACT_ID = "tools:registry" as const;
export const DESCRIPTION = "Central tool registry — registration, lookup, and single tool-execution chokepoint.";
