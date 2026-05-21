import type { CompletionItem, ConfigStoreService, FieldSchema } from "llm-contracts/public";

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

function fieldDetail(field: FieldSchema): string {
  const base = field.type;
  if (field.type === "string" && field.secret) return `${base} · secret`;
  return base;
}

export async function keyEqualsValueCompletions(
  store: ConfigStoreService,
  prev: string[],
): Promise<CompletionItem[]> {
  const plugin = prev[0];
  if (!plugin) return [];
  const spec = store.getSpec(plugin);
  const schema = spec?.schema ?? {};
  const items: CompletionItem[] = [];
  for (const [key, field] of Object.entries(schema)) {
    if (!field) continue;
    const f = field as FieldSchema;
    const detail = fieldDetail(f);
    // Terminal value picks get a trailing space so the cursor lands past the
    // token and the next match (flag slot) can fire. Free-form `key=` is left
    // unterminated because the user types the value next.
    if (f.type === "boolean") {
      items.push({ label: `${key}=true`, insertText: `${key}=true `, detail });
      items.push({ label: `${key}=false`, insertText: `${key}=false `, detail });
    } else if (f.type === "enum") {
      for (const v of f.values) {
        items.push({ label: `${key}=${v}`, insertText: `${key}=${v} `, detail });
      }
    } else if (f.type === "string" && f.enum) {
      for (const v of f.enum) {
        items.push({ label: `${key}=${v}`, insertText: `${key}=${v} `, detail });
      }
    } else {
      items.push({ label: key, insertText: `${key}=`, detail });
    }
  }
  return items;
}

export async function keyOnlyCompletions(
  store: ConfigStoreService,
  prev: string[],
): Promise<CompletionItem[]> {
  const plugin = prev[0];
  if (!plugin) return [];
  const spec = store.getSpec(plugin);
  const schema = spec?.schema ?? {};
  const items: CompletionItem[] = [];
  for (const [key, field] of Object.entries(schema)) {
    if (!field) continue;
    // Terminal pick for /config:get / /config:unset; user moves on to flags or submit.
    items.push({ label: key, insertText: `${key} `, detail: fieldDetail(field as FieldSchema) });
  }
  return items;
}
