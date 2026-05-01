export interface StatusState {
  model: string | null;
  promptTokens: number;
  completionTokens: number;
  turnInFlight: boolean;
  currentTool: string | null;
  turnState: "ready" | "thinking" | string; // also "calling <tool>"
  cleared: boolean; // one-shot flag — driver clears after emitting status:item-clear
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
      }
      // Do NOT flip turnInFlight here — turn:end is the authoritative end signal.
      return recompute(s);
    }

    case "turn:end":
      s.turnInFlight = false;
      s.currentTool = null;
      return recompute(s);

    case "conversation:cleared":
      s.promptTokens = 0;
      s.completionTokens = 0;
      s.cleared = true;
      return recompute(s);

    default:
      return prev; // no-op for events we do not handle
  }
}
