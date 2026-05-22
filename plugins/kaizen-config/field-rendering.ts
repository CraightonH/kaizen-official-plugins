import type { FieldSchema } from "llm-contracts/public";

const SECRET_MASK = "***";
const UNSET_MARKER = "(unset)";
const ERROR_MARKER = "(error)";
const ELLIPSIS = "…";

export function formatValue(
  value: unknown,
  field: FieldSchema,
  opts: { max: number },
): string {
  if (value === null || value === undefined) return UNSET_MARKER;
  if (field.type === "string" && field.secret) return SECRET_MASK;

  let rendered: string;
  try {
    if (typeof value === "string") rendered = value;
    else if (typeof value === "number" || typeof value === "boolean") rendered = String(value);
    else rendered = JSON.stringify(value);
  } catch {
    return ERROR_MARKER;
  }

  if (rendered.length > opts.max) {
    return rendered.slice(0, opts.max - 1) + ELLIPSIS;
  }
  return rendered;
}
