export interface TurnRecord {
  turnId: string;
  parentTurnId?: string;
  trigger: "user" | "agent";
}

export function computeDepth(turns: Map<string, TurnRecord>, turnId: string): number {
  let cur = turns.get(turnId);
  if (!cur) return 0;
  // Count agent ancestors up to (and stopping at) the user turn.
  let depth = 0;
  let safety = 0;
  while (cur && cur.trigger === "agent") {
    depth++;
    if (!cur.parentTurnId) break;
    cur = turns.get(cur.parentTurnId);
    if (++safety > 1024) break; // pathological cycle guard
  }
  return depth;
}
