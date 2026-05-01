import type { MemoryEntry, MemoryScope, MemoryStoreService, MemoryType } from "./public.d.ts";

// Match the Spec 0 ToolsRegistryService surface without importing it (avoid build-time coupling).
export interface ToolsRegistryLike {
  register(
    schema: { name: string; description: string; parameters: Record<string, unknown>; tags?: string[] },
    handler: (args: any, ctx: { signal: AbortSignal; callId: string; turnId?: string; log: (m: string) => void }) => Promise<unknown>,
  ): () => void;
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
    await store.put({ name, description, type, scope, body: content });
    return { ok: true, path: `${scope}:${name}` };
  };

  const u1 = registry.register(
    {
      name: "memory_recall",
      description: "Load the full body of one or more saved memories from llm-memory.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          names: { type: "array", items: { type: "string" } },
          type: { type: "string", enum: ["user", "feedback", "project", "reference"] },
        },
      },
      tags: ["memory", "read"],
    },
    recallHandler,
  );

  const u2 = registry.register(
    {
      name: "memory_save",
      description: "Persist a new memory for future turns. Refuses overwrite unless name ends with `!`.",
      parameters: {
        type: "object",
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
    },
    saveHandler,
  );

  return {
    unregister: () => { try { u1(); } catch {} try { u2(); } catch {} },
  };
}
