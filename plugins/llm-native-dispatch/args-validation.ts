export function isValidToolArgs(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== "object") return false;
  if (value instanceof Error) return false;
  return true;
}

export function malformedArgsMessage(raw: unknown): string {
  let rawStr: string;
  if (typeof raw === "string") rawStr = raw;
  else if (raw instanceof Error) rawStr = String(raw.message);
  else {
    try { rawStr = JSON.stringify(raw); } catch { rawStr = String(raw); }
  }
  return JSON.stringify({ error: "malformed arguments JSON from LLM", raw: rawStr });
}
