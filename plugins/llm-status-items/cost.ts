import type { CostRateEntry } from "./public.d.ts";

export type RateEntry = CostRateEntry;
export type RateTable = Record<string, RateEntry>;

export function tokensToCents(
  rates: RateTable,
  model: string,
  usage: { promptTokens: number; completionTokens: number },
): number | null {
  const r = rates[model];
  if (!r) return null;
  return (usage.promptTokens * r.promptCentsPerMTok + usage.completionTokens * r.completionCentsPerMTok) / 1_000_000;
}

export function formatDollars(cents: number, decimalPlaces: number): string {
  const dollars = cents / 100;
  return `$${dollars.toFixed(decimalPlaces)}`;
}
