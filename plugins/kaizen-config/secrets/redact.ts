import { isSecretRef, type ConfigSchema, type FieldSchema } from "llm-contracts/public";

export function redactValue(value: unknown, fieldSchema: FieldSchema | undefined): unknown {
  if (!fieldSchema || fieldSchema.type !== "string" || !fieldSchema.secret) return value;
  if (isSecretRef(value)) {
    const idx = value.$ref.indexOf(":");
    const scheme = idx > 0 ? value.$ref.slice(0, idx) : "unknown";
    return `<redacted:${scheme}>`;
  }
  return "<redacted>";
}

export function redactSnapshot<T>(snapshot: T, schema: ConfigSchema<T> | undefined): T {
  if (!schema || typeof snapshot !== "object" || snapshot === null) return snapshot;
  const out: Record<string, unknown> = { ...(snapshot as Record<string, unknown>) };
  for (const [key, fieldSchema] of Object.entries(schema)) {
    if (!fieldSchema) continue;
    if (!(key in out)) continue;
    out[key] = redactValue(out[key], fieldSchema as FieldSchema);
  }
  return out as T;
}
