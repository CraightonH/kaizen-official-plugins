import { parse } from "./parser.ts";

export interface ArgSlotInfo {
  name: string;
  slotIndex: number;
  prevArgs: string[];
  query: string;
  anchor: number;
  flagMode: boolean;
}

/**
 * Pure parsing: given a line and cursor position, returns the slot info
 * that argument completion should fire against. Returns null if the line
 * isn't a slash command or doesn't have a parseable slot at the cursor.
 *
 * Flag tokens (starting with "--") are stripped from positional slot index
 * computation but reported as flag-slot context. Callers refine `flagMode`
 * against the manifest's `arguments.length` and `flags` list.
 */
export function computeArgSlot(line: string, cursor: number): ArgSlotInfo | null {
  const parsed = parse(line);
  if (!parsed) return null;
  const argsStart = line.length - parsed.args.length;
  if (cursor < argsStart) return null;

  // Tokenize the args region: walk forward through whitespace and non-whitespace
  // runs, recording each token's absolute [start, end) in line coords.
  const tokens: Array<{ value: string; start: number; end: number; isFlag: boolean }> = [];
  let i = argsStart;
  while (i < line.length) {
    while (i < line.length && /\s/.test(line[i]!)) i++;
    if (i >= line.length) break;
    const start = i;
    while (i < line.length && !/\s/.test(line[i]!)) i++;
    const value = line.slice(start, i);
    tokens.push({ value, start, end: i, isFlag: value.startsWith("--") });
  }

  // Identify the token (or whitespace gap) under the cursor.
  let activeToken: { value: string; start: number; end: number; isFlag: boolean } | null = null;
  for (const t of tokens) {
    if (cursor >= t.start && cursor <= t.end) { activeToken = t; break; }
  }

  // Positional tokens before the cursor, excluding the active token itself.
  const positionalBefore: string[] = [];
  for (const t of tokens) {
    if (activeToken && t === activeToken) break;
    if (t.end > cursor) break;
    if (!t.isFlag) positionalBefore.push(t.value);
  }

  const slotIndex = positionalBefore.length;
  const query = activeToken ? activeToken.value.slice(0, cursor - activeToken.start) : "";
  const anchor = activeToken ? activeToken.start : cursor;
  const flagMode = activeToken?.isFlag === true || (!activeToken && positionalBefore.length >= 2);

  return { name: parsed.name, slotIndex, prevArgs: positionalBefore, query, anchor, flagMode };
}
