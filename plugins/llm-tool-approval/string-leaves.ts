/**
 * Depth-first collect every string-typed leaf in `args`. Non-string primitives
 * are skipped. Cycles abort their branch. Stops once `max` leaves are
 * collected (default 32).
 */
export function stringLeaves(args: unknown, max = 32): string[] {
  const out: string[] = [];
  const seen = new WeakSet<object>();

  const visit = (v: unknown): void => {
    if (out.length >= max) return;
    if (typeof v === "string") {
      out.push(v);
      return;
    }
    if (v === null || typeof v !== "object") return;
    if (seen.has(v as object)) return;
    seen.add(v as object);
    if (Array.isArray(v)) {
      for (const item of v) {
        if (out.length >= max) return;
        visit(item);
      }
      return;
    }
    for (const val of Object.values(v as Record<string, unknown>)) {
      if (out.length >= max) return;
      visit(val);
    }
  };

  visit(args);
  return out;
}
