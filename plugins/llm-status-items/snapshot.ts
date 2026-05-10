import type { StatusState } from "./state.ts";

export interface StatusSnapshot {
  model: string | null;
  session: { id: string | null; alias: string | null };
  contextWindow: {
    lastPromptTokens: number;
    contextLength: number | null;
    pctUsed: number | null;
  };
  sessionTotals: {
    promptTokens: number;
    completionTokens: number;
  };
  tokensPerSec: number | null;
  costCents: number | null;
}

export function buildSnapshot(state: StatusState, costCents: number | null): StatusSnapshot {
  const { contextLength, lastPromptTokens } = state;
  const pctUsed = contextLength && contextLength > 0
    ? lastPromptTokens / contextLength
    : null;
  return {
    model: state.model,
    session: { id: state.sessionId, alias: state.sessionAlias },
    contextWindow: { lastPromptTokens, contextLength, pctUsed },
    sessionTotals: {
      promptTokens: state.promptTokens,
      completionTokens: state.completionTokens,
    },
    tokensPerSec: state.tokensPerSec,
    costCents,
  };
}
