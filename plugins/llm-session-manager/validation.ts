const CHILD_RE = /^[A-Za-z0-9_.-]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isValidChildId(s: string): boolean {
  return CHILD_RE.test(s) && s !== ".." && !s.includes("\\");
}

export interface ParsedSessionId {
  topLevelId: string;
  childPath: string[];
}

export function parseSessionId(id: string): ParsedSessionId {
  const parts = id.split("/");
  return { topLevelId: parts[0] ?? "", childPath: parts.slice(1) };
}

export function validateFullSessionId(id: string): void {
  if (id.length === 0) throw new Error("session id is empty");
  const segments = id.split("/");
  for (const seg of segments) {
    if (seg.length === 0) throw new Error("invalid session id: empty segment");
    if (seg === "..") throw new Error("invalid session id: '..' segment");
    if (seg.includes("\\")) throw new Error("invalid session id: path separator in segment");
  }
  const [top, ...children] = segments;
  if (!UUID_RE.test(top ?? "")) {
    throw new Error(`invalid session id: top-level '${top}' is not a manager-minted UUID`);
  }
  for (const child of children) {
    if (!isValidChildId(child)) {
      throw new Error(`invalid session id: child segment '${child}' must match ${CHILD_RE.source}`);
    }
  }
}
