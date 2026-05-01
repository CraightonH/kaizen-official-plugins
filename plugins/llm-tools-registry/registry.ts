import type {
  ToolSchema,
} from "llm-events/public";

const CANCEL_TOOL: unique symbol = Symbol.for("kaizen.cancel") as never;

export interface ToolExecutionContext {
  signal: AbortSignal;
  callId: string;
  turnId?: string;
  log: (msg: string) => void;
}

export type ToolHandler = (args: unknown, ctx: ToolExecutionContext) => Promise<unknown>;

export interface ToolsRegistryService {
  register(schema: ToolSchema, handler: ToolHandler): () => void;
  list(filter?: { tags?: string[]; names?: string[] }): ToolSchema[];
  invoke(name: string, args: unknown, ctx: ToolExecutionContext): Promise<unknown>;
}

interface Entry { schema: ToolSchema; handler: ToolHandler; }

type Emit = (event: string, payload: unknown) => Promise<unknown[]>;

export function makeRegistry(emit: Emit): ToolsRegistryService {
  const entries = new Map<string, Entry>();

  function register(schema: ToolSchema, handler: ToolHandler): () => void {
    if (typeof schema.name !== "string" || schema.name.length === 0) {
      throw new Error("ToolSchema.name must be a non-empty string");
    }
    if (entries.has(schema.name)) {
      throw new Error(`tool already registered: ${schema.name}`);
    }
    const entry: Entry = { schema, handler };
    entries.set(schema.name, entry);
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      // Reference identity: only remove if this exact entry is still mapped.
      const cur = entries.get(schema.name);
      if (cur === entry) entries.delete(schema.name);
    };
  }

  function list(filter?: { tags?: string[]; names?: string[] }): ToolSchema[] {
    const out: ToolSchema[] = [];
    const tagSet = filter?.tags ? new Set(filter.tags) : null;
    const nameSet = filter?.names ? new Set(filter.names) : null;
    for (const { schema } of entries.values()) {
      if (nameSet && !nameSet.has(schema.name)) continue;
      if (tagSet) {
        const tags = schema.tags ?? [];
        let any = false;
        for (const t of tags) if (tagSet.has(t)) { any = true; break; }
        if (!any) continue;
      }
      out.push(schema);
    }
    return out;
  }

  async function invoke(name: string, args: unknown, ctx: ToolExecutionContext): Promise<unknown> {
    const entry = entries.get(name);
    if (!entry) {
      const message = `unknown tool: ${name}`;
      await emit("tool:error", { name, callId: ctx.callId, message });
      throw new Error(message);
    }

    const beforePayload: { name: string; args: unknown; callId: string } = { name, args, callId: ctx.callId };
    await emit("tool:before-execute", beforePayload);

    if (beforePayload.args === CANCEL_TOOL) {
      const message = "cancelled by subscriber";
      await emit("tool:error", { name, callId: ctx.callId, message });
      const err = new Error(message);
      (err as any).name = "AbortError";
      throw err;
    }

    await emit("tool:execute", { name, args: beforePayload.args, callId: ctx.callId });

    try {
      const result = await entry.handler(beforePayload.args, ctx);
      await emit("tool:result", { name, callId: ctx.callId, result });
      return result;
    } catch (err) {
      const message = String((err as any)?.message ?? err);
      await emit("tool:error", { name, callId: ctx.callId, message, cause: err });
      throw err;
    }
  }

  return { register, list, invoke };
}
