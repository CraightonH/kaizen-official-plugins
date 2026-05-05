/** Width of the visual fill bar in cells. Kept short — status bar is one row. */
const BAR_WIDTH = 10;

const FILL = "█";
const EMPTY = "░";

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  // 1.2k under 10k, 12k beyond — keeps the field at most 4 chars wide.
  return k < 10 ? `${k.toFixed(1)}k` : `${Math.round(k)}k`;
}

/**
 * Render the context-window status item: `13.2k/32k [████░░░░░░] 41%`.
 * Caller is responsible for not invoking this when the ceiling is unknown.
 */
export function formatContextItem(used: number, ceiling: number): string {
  const pct = ceiling > 0 ? Math.min(1, Math.max(0, used / ceiling)) : 0;
  const filled = Math.round(pct * BAR_WIDTH);
  const bar = FILL.repeat(filled) + EMPTY.repeat(BAR_WIDTH - filled);
  const pctStr = `${Math.round(pct * 100)}%`;
  return `${formatTokens(used)}/${formatTokens(ceiling)} [${bar}] ${pctStr}`;
}
