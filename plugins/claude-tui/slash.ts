import type { TuiStore } from "./state/store.ts";

export type SlashResult = "swallow" | "forward";

export function handleSlash(line: string, store: TuiStore): SlashResult {
  const t = line.trim();
  if (t === "/clear") {
    store.clearLog();
    return "swallow";
  }
  return "forward";
}
