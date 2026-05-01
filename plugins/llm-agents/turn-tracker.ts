import type { TurnRecord } from "./depth.ts";

export interface TurnTracker {
  records: Map<string, TurnRecord>;
  onTurnStart(p: { turnId: string; trigger: "user" | "agent"; parentTurnId?: string }): void;
  onTurnEnd(p: { turnId: string }): void;
  isTopLevel(turnId: string): boolean;
}

export function makeTurnTracker(): TurnTracker {
  const records = new Map<string, TurnRecord>();
  return {
    records,
    onTurnStart(p) {
      records.set(p.turnId, { turnId: p.turnId, parentTurnId: p.parentTurnId, trigger: p.trigger });
    },
    onTurnEnd(p) { records.delete(p.turnId); },
    isTopLevel(turnId) { return records.get(turnId)?.trigger === "user"; },
  };
}
