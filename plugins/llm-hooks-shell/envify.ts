const DEPTH_CAP = 4;

export function camelToUpperSnake(name: string): string {
  // Insert underscore between a lowercase or digit followed by an uppercase letter.
  // Then collapse runs of capitals so HTTPRequest → HTTP_Request → HTTP_REQUEST.
  const s1 = name.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
  const s2 = s1.replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2");
  return s2.toUpperCase();
}

function scalarString(v: unknown): string {
  if (v === null) return "null";
  if (v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

function flatten(prefix: string, value: unknown, out: Record<string, string>, depth: number): void {
  // At the depth cap, store the JSON blob and stop descending.
  if (depth >= DEPTH_CAP) {
    out[prefix] = JSON.stringify(value);
    return;
  }
  if (Array.isArray(value)) {
    out[prefix] = JSON.stringify(value);
    value.forEach((item, idx) => flatten(`${prefix}_${idx}`, item, out, depth + 1));
    return;
  }
  if (value !== null && typeof value === "object") {
    out[prefix] = JSON.stringify(value);
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const childKey = `${prefix}_${camelToUpperSnake(k)}`;
      flatten(childKey, v, out, depth + 1);
    }
    return;
  }
  out[prefix] = scalarString(value);
}

export function envify(eventName: string, payload: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  out.EVENT_NAME = eventName;
  out.EVENT_JSON = JSON.stringify(payload ?? null);

  if (payload === null || typeof payload !== "object") {
    return out;
  }

  if (Array.isArray(payload)) {
    payload.forEach((item, idx) => flatten(`EVENT_${idx}`, item, out, 1));
    return out;
  }

  for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
    flatten(`EVENT_${camelToUpperSnake(k)}`, v, out, 1);
  }
  return out;
}
