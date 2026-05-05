import type {
  ToolSchema,
} from "llm-events/public";

import type { ToolSource, ToolRegistration } from "./public";

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
  registerWith(reg: ToolRegistration): () => void;
  list(filter?: { tags?: string[]; names?: string[]; sources?: ToolSource["kind"][] }): ToolSchema[];
  listRegistrations(filter?: { tags?: string[]; names?: string[]; sources?: ToolSource["kind"][] }): ToolRegistration[];
  invoke(name: string, args: unknown, ctx: ToolExecutionContext): Promise<unknown>;
}

interface Entry { schema: ToolSchema; handler: ToolHandler; source: ToolSource; }

type Emit = (event: string, payload: unknown) => Promise<unknown[]>;

export function makeRegistry(emit: Emit): ToolsRegistryService {
  const entries = new Map<string, Entry>();

  function registerWith(reg: ToolRegistration): () => void {
    const { schema, handler, source } = reg;
    if (typeof schema.name !== "string" || schema.name.length === 0) {
      throw new Error("ToolSchema.name must be a non-empty string");
    }
    if (entries.has(schema.name)) {
      throw new Error(`tool already registered: ${schema.name}`);
    }
    const entry: Entry = { schema, handler, source };
    entries.set(schema.name, entry);
    emit("tools:registered", { name: schema.name, source });
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      // Reference identity: only remove if this exact entry is still mapped.
      const cur = entries.get(schema.name);
      if (cur === entry) {
        entries.delete(schema.name);
        emit("tools:unregistered", { name: schema.name, source });
      }
    };
  }

  function register(schema: ToolSchema, handler: ToolHandler): () => void {
    return registerWith({ schema, handler, source: { kind: "local" } });
  }

  function matchesFilter(
    entry: Entry,
    filter?: { tags?: string[]; names?: string[]; sources?: ToolSource["kind"][] },
  ): boolean {
    if (!filter) return true;
    const { tags, names, sources } = filter;
    if (names && !new Set(names).has(entry.schema.name)) return false;
    if (sources && !new Set(sources).has(entry.source.kind)) return false;
    if (tags) {
      const tagSet = new Set(tags);
      const schemaTags = entry.schema.tags ?? [];
      let any = false;
      for (const t of schemaTags) if (tagSet.has(t)) { any = true; break; }
      if (!any) return false;
    }
    return true;
  }

  function list(filter?: { tags?: string[]; names?: string[]; sources?: ToolSource["kind"][] }): ToolSchema[] {
    const out: ToolSchema[] = [];
    for (const entry of entries.values()) {
      if (matchesFilter(entry, filter)) out.push(entry.schema);
    }
    return out;
  }

  function listRegistrations(filter?: { tags?: string[]; names?: string[]; sources?: ToolSource["kind"][] }): ToolRegistration[] {
    const out: ToolRegistration[] = [];
    for (const entry of entries.values()) {
      if (matchesFilter(entry, filter)) {
        out.push({ schema: entry.schema, handler: entry.handler, source: entry.source });
      }
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

  return { register, registerWith, list, listRegistrations, invoke };
}
