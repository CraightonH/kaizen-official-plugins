import { parse } from "./parser.ts";
import { filterByQuery } from "./query-match.ts";
import type { SlashRegistryService, CompletionItem, CompletionSource } from "llm-contracts/public";

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

export function buildArgCompletionSource(registry: SlashRegistryService): CompletionSource {
  return {
    id: "llm-slash-commands:args",
    match(line, cursor) {
      const slot = computeArgSlot(line, cursor);
      if (!slot) return null;
      const entry = registry.get(slot.name);
      if (!entry) return null;
      const args = entry.manifest.arguments ?? [];
      const flags = entry.manifest.flags ?? [];

      // Positional slot in range and the active position isn't a flag token.
      if (slot.slotIndex < args.length && !slot.flagMode) {
        if (!args[slot.slotIndex]!.complete) return null;
        return { triggerPos: slot.anchor, query: slot.query };
      }
      // Flag slot: positional slots filled (or flag token under cursor) AND flags remain.
      if (slot.slotIndex >= args.length || slot.flagMode) {
        const flagsLeft = flags.filter((f) => !line.includes(` ${f.name}`));
        if (flagsLeft.length === 0) return null;
        return { triggerPos: slot.anchor, query: slot.query };
      }
      return null;
    },
    async list(_query, ctx) {
      if (!ctx) return [];
      const slot = computeArgSlot(ctx.line, ctx.cursor);
      if (!slot) return [];
      const entry = registry.get(slot.name);
      if (!entry) return [];
      const args = entry.manifest.arguments ?? [];
      const flags = entry.manifest.flags ?? [];

      if (slot.slotIndex < args.length && !slot.flagMode) {
        const argSpec = args[slot.slotIndex]!;
        const fn = argSpec.complete;
        if (!fn) return [];
        const items = await fn(slot.prevArgs, slot.query);
        return argSpec.selfFilters ? items : filterByQuery(items, slot.query);
      }

      // Flag slot: return one item per declared flag not yet present in the line.
      const present = new Set<string>();
      for (const tok of ctx.line.split(/\s+/)) {
        if (tok.startsWith("--")) present.add(tok);
      }
      return flags
        .filter((f) => !present.has(f.name))
        .map<CompletionItem>((f) => ({
          label: f.name,
          // Trailing space so a subsequent flag can be picked without manual spacing.
          insertText: `${f.name} `,
          detail: f.description,
        }));
    },
  };
}
