import { readFile as fsReadFile } from "node:fs/promises";
import { homedir } from "node:os";

export interface RateEntry {
  promptCentsPerMTok: number;
  completionCentsPerMTok: number;
}
export type RateTable = Record<string, RateEntry>;

export interface CostDeps {
  home: string;
  readFile: (path: string) => Promise<string>;
}

export function realCostDeps(): CostDeps {
  return {
    home: homedir(),
    readFile: (p) => fsReadFile(p, "utf8"),
  };
}

const RATE_FILE_REL = ".kaizen/plugins/llm-status-items/cost-table.json";

export async function loadRateTable(deps: CostDeps): Promise<RateTable> {
  const path = `${deps.home}/${RATE_FILE_REL}`;
  let text: string;
  try {
    text = await deps.readFile(path);
  } catch (e: any) {
    if (e?.code === "ENOENT") return {};
    throw e;
  }
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`llm-status-items: cost-table at ${path} is malformed JSON: ${(e as Error).message}`);
  }
  const rates = parsed?.rates;
  if (rates && typeof rates === "object") return rates as RateTable;
  return {};
}

export function tokensToCents(
  rates: RateTable,
  model: string,
  usage: { promptTokens: number; completionTokens: number },
): number | null {
  const r = rates[model];
  if (!r) return null;
  return (usage.promptTokens * r.promptCentsPerMTok + usage.completionTokens * r.completionCentsPerMTok) / 1_000_000;
}

export function formatDollars(cents: number): string {
  const dollars = cents / 100;
  // 4 decimals per spec.
  return `$${dollars.toFixed(4)}`;
}
