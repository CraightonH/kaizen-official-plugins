import type { ToolSchema } from "../public";

export interface ToolExecutionContext {
  signal: AbortSignal;
  callId: string;
  turnId?: string;
  sessionId?: string;
  log: (msg: string) => void;
}

export interface ToolBeforeExecutePayload {
  name: string;
  /**
   * Subscribers may overwrite to mutate the args the handler sees, or set
   * to `CANCEL_TOOL` (`Symbol.for("kaizen.cancel")`) to cancel the call.
   */
  args: unknown;
  callId: string;
  turnId?: string;
  sessionId?: string;
  /**
   * Optional human-readable cancellation reason. When `args === CANCEL_TOOL`,
   * the registry emits `tool:error` with this string as the message
   * (defaulting to `"cancelled by subscriber"` when absent) and rejects with
   * an `AbortError` whose `.message` matches. Additive: existing subscribers
   * that don't set this field see no behavior change.
   */
  cancelReason?: string;
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
