export interface StatusState {
  model: string | null;
  promptTokens: number;
  completionTokens: number;
  turnInFlight: boolean;
  currentTool: string | null;
  turnState: "ready" | "thinking" | string; // also "calling <tool>"
  cleared: boolean; // one-shot flag — driver clears after emitting status:item-clear
  /** Tokens-per-second for the most recently completed turn; null until first measurement. */
  tokensPerSec: number | null;
  /** completionTokens snapshot at turn:start, used to compute per-turn delta. */
  turnStartCompletion: number;
  /** wall-clock ms when the current turn started; used to compute tok/s. */
  turnStartedAt: number | null;
  /** Resolved context-window ceiling for the active model; null until listModels() reports back (or returns nothing). */
  contextLength: number | null;
  /** promptTokens from the most recent llm:done — what the model actually saw on its last call. */
  lastPromptTokens: number;
}

export function initialState(): StatusState {
  return {
    model: null,
    promptTokens: 0,
    completionTokens: 0,
    turnInFlight: false,
    currentTool: null,
    turnState: "ready",
    cleared: false,
    tokensPerSec: null,
    turnStartCompletion: 0,
    turnStartedAt: null,
    contextLength: null,
    lastPromptTokens: 0,
  };
}

function recompute(s: StatusState): StatusState {
  if (s.currentTool) {
    return { ...s, turnState: `calling ${s.currentTool}` };
  }
  if (s.turnInFlight) {
    return { ...s, turnState: "thinking" };
  }
  return { ...s, turnState: "ready" };
}

export function applyEvent(prev: StatusState, name: string, payload: any): StatusState {
  // Always reset the one-shot cleared flag at the top of each event.
  let s: StatusState = { ...prev, cleared: false };

  switch (name) {
    case "turn:start":
      s.turnInFlight = true;
      s.currentTool = null;
      s.turnStartedAt = Date.now();
      s.turnStartCompletion = s.completionTokens;
      return recompute(s);

    case "llm:before-call": {
      const model = payload?.request?.model;
      if (typeof model === "string" && model.length > 0) s.model = model;
      // Do not flip turnInFlight — turn:start owns that. Recompute is idempotent.
      return recompute(s);
    }

    case "tool:before-execute": {
      const toolName = typeof payload?.name === "string" ? payload.name : "tool";
      s.currentTool = toolName;
      return recompute(s);
    }

    case "tool:result":
    case "tool:error":
      s.currentTool = null;
      return recompute(s);

    case "llm:done": {
      const usage = payload?.response?.usage;
      if (usage && typeof usage.promptTokens === "number" && typeof usage.completionTokens === "number") {
        s.promptTokens += usage.promptTokens;
        s.completionTokens += usage.completionTokens;
        // Track the most recent call's prompt size separately from the running
        // total. The context-window bar denominates against per-call prompt
        // (rebuilt each turn), not cumulative session tokens.
        s.lastPromptTokens = usage.promptTokens;
      }
      // Do NOT flip turnInFlight here — turn:end is the authoritative end signal.
      return recompute(s);
    }

    case "turn:end": {
      const durationMs = typeof payload?.durationMs === "number" && payload.durationMs > 0
        ? payload.durationMs
        : (s.turnStartedAt ? Math.max(1, Date.now() - s.turnStartedAt) : 0);
      const completionDelta = Math.max(0, s.completionTokens - s.turnStartCompletion);
      if (durationMs > 0 && completionDelta > 0) {
        s.tokensPerSec = (completionDelta * 1000) / durationMs;
      }
      s.turnInFlight = false;
      s.currentTool = null;
      s.turnStartedAt = null;
      return recompute(s);
    }

    case "conversation:cleared":
      s.promptTokens = 0;
      s.completionTokens = 0;
      s.tokensPerSec = null;
      s.turnStartCompletion = 0;
      s.lastPromptTokens = 0;
      // contextLength is a property of the model, not the conversation —
      // keep the cached value across `/clear` so we don't re-list models.
      s.cleared = true;
      return recompute(s);

    default:
      return prev; // no-op for events we do not handle
  }
}
