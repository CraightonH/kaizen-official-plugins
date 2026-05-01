export interface SerializeResult {
  content: string;
  circular: boolean;
}

export function serializeResult(value: unknown): SerializeResult {
  if (typeof value === "string") return { content: value, circular: false };
  if (value === undefined || value === null) return { content: "", circular: false };
  try {
    return { content: JSON.stringify(value), circular: false };
  } catch {
    return { content: String(value), circular: true };
  }
}

export function serializeError(message: string): string {
  return JSON.stringify({ error: message });
}
