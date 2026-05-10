import type { StatusSnapshot } from "./snapshot.ts";
import { formatDollars } from "./cost.ts";

export interface SlashCommandManifestLike {
  name: string;
  description: string;
  source: "builtin" | "plugin";
  usage?: string;
}
export interface SlashCommandContextLike {
  args: string;
  print: (text: string) => Promise<void>;
}
export interface SlashRegistryLike {
  register(manifest: SlashCommandManifestLike, handler: (ctx: SlashCommandContextLike) => Promise<void>): () => void;
}

const NUM = new Intl.NumberFormat("en-US");

function formatTokensPerSec(v: number): string {
  return v >= 100 ? v.toFixed(0) : v.toFixed(1);
}


export function formatSnapshot(snap: StatusSnapshot): string {
  const lines: string[] = [];

  if (snap.model) {
    lines.push(`model:           ${snap.model}`);
  }
  if (snap.session.id) {
    const sess = snap.session.alias
      ? `${snap.session.id} (${snap.session.alias})`
      : snap.session.id;
    lines.push(`session:         ${sess}`);
  }

  // Context window line: always rendered. Ceiling + % only when known.
  const used = NUM.format(snap.contextWindow.lastPromptTokens);
  if (snap.contextWindow.contextLength != null && snap.contextWindow.pctUsed != null) {
    const ceiling = NUM.format(snap.contextWindow.contextLength);
    const pct = Math.round(snap.contextWindow.pctUsed * 100);
    lines.push(`context window:  ${used} / ${ceiling}  (${pct}%)`);
  } else {
    lines.push(`context window:  ${used}`);
  }

  lines.push(
    `session totals:  in=${NUM.format(snap.sessionTotals.promptTokens)}  ` +
      `out=${NUM.format(snap.sessionTotals.completionTokens)}`,
  );

  if (snap.tokensPerSec != null) {
    lines.push(`tok/s (last):    ${formatTokensPerSec(snap.tokensPerSec)}`);
  }
  if (snap.costCents != null) {
    lines.push(`cost (est):      ${formatDollars(snap.costCents)}`);
  }

  return lines.join("\n");
}

export function registerStatusSlash(
  slash: SlashRegistryLike,
  getSnapshot: () => StatusSnapshot,
): Array<() => void> {
  const off = slash.register(
    {
      name: "status:show",
      description: "Show current status-bar values: model, context-window usage, session token totals, throughput, and cost.",
      source: "plugin",
    },
    async (ctx) => {
      await ctx.print(formatSnapshot(getSnapshot()));
    },
  );
  return [off];
}
