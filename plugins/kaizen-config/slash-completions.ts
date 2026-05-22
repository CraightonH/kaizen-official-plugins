import type {
  CompletionItem,
  ConfigResolutionSource,
  ConfigStoreService,
  FieldSchema,
} from "llm-contracts/public";
import { renderFieldRow, renderValueRows } from "./field-rendering.ts";

function resolutionDetail(homeExists: boolean, projectExists: boolean): string {
  const parts: string[] = [];
  if (homeExists) parts.push("home");
  if (projectExists) parts.push("project");
  return parts.length ? parts.join("+") : "(unset)";
}

export async function pluginCompletions(store: ConfigStoreService): Promise<CompletionItem[]> {
  // Trailing space pushes the cursor past the token so the next slot's
  // match predicate fires instead of re-suggesting plugins.
  return store.list().map((row) => ({
    label: row.plugin,
    insertText: `${row.plugin} `,
    detail: resolutionDetail(row.homeExists, row.projectExists),
  }));
}

export async function keyEqualsValueCompletions(
  store: ConfigStoreService,
  prev: string[],
  query: string = "",
): Promise<CompletionItem[]> {
  const plugin = prev[0];
  if (!plugin) return [];
  const spec = store.getSpec(plugin);
  const schema = spec?.schema as Record<string, FieldSchema | undefined> | undefined;
  if (!schema) return [];

  let merged: Record<string, unknown> = {};
  try { merged = store.get(plugin) as Record<string, unknown>; } catch { merged = {}; }
  const status = store.list().find((r) => r.plugin === plugin);
  const resolution = (status?.resolution ?? {}) as Record<string, ConfigResolutionSource>;

  const eqIdx = query.indexOf("=");
  if (eqIdx === -1) {
    const rows: CompletionItem[] = [];
    for (const [key, field] of Object.entries(schema)) {
      if (!field) continue;
      const source = resolution[key] ?? "default";
      rows.push(renderFieldRow({
        key,
        field,
        currentValue: merged[key],
        source,
        isSet: source !== "default",
      }));
    }
    return rows;
  }

  const key = query.slice(0, eqIdx);
  const valueQuery = query.slice(eqIdx + 1);
  const field = schema[key];
  if (!field) return [];
  const source = resolution[key] ?? "default";
  return renderValueRows(
    { key, field, currentValue: merged[key], source, isSet: source !== "default" },
    valueQuery,
  );
}

export async function keyOnlyCompletions(
  store: ConfigStoreService,
  prev: string[],
): Promise<CompletionItem[]> {
  const plugin = prev[0];
  if (!plugin) return [];
  const spec = store.getSpec(plugin);
  const schema = spec?.schema as Record<string, FieldSchema | undefined> | undefined;
  if (!schema) return [];

  let merged: Record<string, unknown> = {};
  try {
    merged = store.get(plugin) as Record<string, unknown>;
  } catch {
    merged = {};
  }
  const status = store.list().find((r) => r.plugin === plugin);
  const resolution = (status?.resolution ?? {}) as Record<string, ConfigResolutionSource>;

  const rows: CompletionItem[] = [];
  for (const [key, field] of Object.entries(schema)) {
    if (!field) continue;
    const source = resolution[key] ?? "default";
    const row = renderFieldRow({
      key, field, currentValue: merged[key], source, isSet: source !== "default",
    });
    // /config:get and /config:unset don't take a value — the field row should
    // insert `key ` (trailing space, no `=`), not the field-tier pre-fill.
    rows.push({ label: row.label, insertText: `${key} `, detail: row.detail });
  }
  return rows;
}
