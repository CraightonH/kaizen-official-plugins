export interface Vocab {
  readonly SESSION_START: "session:start";
  readonly SESSION_END: "session:end";
  readonly SESSION_ERROR: "session:error";
  readonly TURN_BEFORE: "turn:before";
  readonly TURN_AFTER: "turn:after";
  readonly TURN_CANCEL: "turn:cancel";
  readonly STATUS_ITEM_UPDATE: "status:item-update";
  readonly STATUS_ITEM_CLEAR: "status:item-clear";
}
export type EventName = Vocab[keyof Vocab];

export interface StatusItem {
  id: string;
  content: string;
  priority?: number;
  ttlMs?: number;
}

export interface TurnAfterPayload {
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  durationMs: number;
}
