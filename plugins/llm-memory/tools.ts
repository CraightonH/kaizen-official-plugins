import type { MemoryEntry, MemoryScope, MemoryStoreService, MemoryType } from "./public.d.ts";
import type { ToolRegistration, ToolSchema } from "llm-tools-registry/public";

// Match the ToolsRegistryService surface without importing the full service interface
// (avoid build-time coupling to llm-tools-registry's optional ctx surface).
export interface ToolsRegistryLike {
  register(
    schema: ToolSchema,
    handler: (args: any, ctx: { signal: AbortSignal; callId: string; turnId?: string; log: (m: string) => void }) => Promise<unknown>,
  ): () => void;
  registerWith?(registration: ToolRegistration): () => void;
}

export interface RegisterToolsOptions {
  log: (msg: string) => void;
  denyTypes: MemoryType[];
}

export interface RegisterToolsResult {
  unregister: () => void;
}

export function registerTools(
  registry: ToolsRegistryLike,
  store: MemoryStoreService,
  opts: RegisterToolsOptions,
): RegisterToolsResult {
  const denied = new Set(opts.denyTypes);
  const filterDenied = (es: MemoryEntry[]): MemoryEntry[] => es.filter((e) => !denied.has(e.type));

  const recallHandler = async (args: any, _ctx: any) => {
    const names = Array.isArray(args?.names) ? args.names.map(String) : null;
    const query = typeof args?.query === "string" ? args.query : null;
    const typeFilter: MemoryType | null = typeof args?.type === "string" ? (args.type as MemoryType) : null;

    if (names) {
      const found: MemoryEntry[] = [];
      const missing: string[] = [];
      for (const n of names) {
        const e = await store.get(n);
        if (e && !denied.has(e.type) && (!typeFilter || e.type === typeFilter)) {
          found.push(e);
        } else {
          missing.push(n);
        }
      }
      return {
        entries: found.map(({ name, scope, type, description, body }) => ({ name, scope, type, description, body })),
        missing,
      };
    }
    const matches = await store.search(query ?? "", { limit: 5 });
    let filtered = filterDenied(matches).slice(0, 5);
    if (typeFilter) filtered = filtered.filter((e) => e.type === typeFilter);
    return {
      entries: filtered.map(({ name, scope, type, description, body }) => ({ name, scope, type, description, body })),
      missing: [],
    };
  };

  const saveHandler = async (args: any, _ctx: any) => {
    const rawName = String(args?.name ?? "");
    const overwrite = rawName.endsWith("!");
    const name = overwrite ? rawName.slice(0, -1) : rawName;
    const description = String(args?.description ?? "");
    const content = String(args?.content ?? "");
    const type: MemoryType = (args?.type ?? "user") as MemoryType;
    const scope: MemoryScope = (args?.scope ?? "global") as MemoryScope;

    const existing = await store.get(name, { scope });
    if (existing && !overwrite) {
      return {
        ok: false,
        error:
          `memory "${name}" already exists. Choose a new name, or pass "${name}!" to overwrite intentionally.`,
      };
    }
    try {
      await store.put({ name, description, type, scope, body: content });
    } catch (err) {
      // Translate store-layer validation/write failures into a structured
      // tool result so the LLM sees a recoverable message rather than the
      // registry surfacing a raw thrown Error.
      return { ok: false, error: `memory_save failed: ${(err as Error).message}` };
    }
    return { ok: true, path: `${scope}:${name}` };
  };

  const recallSchema: ToolSchema = {
    name: "memory_recall",
    description:
      "Load the full body of one or more saved memories from llm-memory. " +
      "Pass `names` to exact-load known entries, or `query` to fuzzy-match name/description (up to 5).",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string" },
        names: { type: "array", items: { type: "string" } },
        type: { type: "string", enum: ["user", "feedback", "project", "reference"] },
      },
    },
    tags: ["memory", "read"],
  };

  const saveSchema: ToolSchema = {
    name: "memory_save",
    description: "Persist a new memory for future turns. Refuses overwrite unless name ends with `!`.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["name", "description", "content", "type"],
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        content: { type: "string" },
        type: { type: "string", enum: ["user", "feedback", "project", "reference"] },
        scope: { type: "string", enum: ["project", "global"] },
      },
    },
    tags: ["memory", "write"],
  };

  const u1 = registry.registerWith
    ? registry.registerWith({ schema: recallSchema, handler: recallHandler, source: { kind: "memory" } })
    : registry.register(recallSchema, recallHandler);

  const u2 = registry.registerWith
    ? registry.registerWith({ schema: saveSchema, handler: saveHandler, source: { kind: "memory" } })
    : registry.register(saveSchema, saveHandler);

  return {
    unregister: () => { try { u1(); } catch {} try { u2(); } catch {} },
  };
}
