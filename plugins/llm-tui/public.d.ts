import type { TuiTheme } from "./theme/loader.ts";

export type { TuiToolRendererService, TuiToolRenderer } from "./tool-renderers/registry";
export type { ToolCallStatus } from "./state/store";

export interface TuiChannelService {
  writeOutput(chunk: string): void;
  writeNotice(text: string): void;
  /**
   * Append a user-authored message to the transcript. Rendered with the
   * prompt accent (magenta `❯` gutter + subtle background highlight) so
   * it visually anchors the start of a turn against the assistant reply.
   */
  writeUser(text: string): void;
  setBusy(state: boolean, message?: string): void;
  /** Set the start time for the current busy period (called on turn:start). */
  setBusyTiming(startedAt: number): void;
  /** Set the absolute completion-token count for the current busy period. */
  updateBusyTokens(deltaTokens: number): void;
  /** Increment the completion-token count by `n` (used during streaming). */
  incrementBusyTokens(n?: number): void;
  readInput(): Promise<string>;
  /** Append a reasoning/thinking delta to the live thinking buffer (rendered above input while busy). */
  appendReasoning(delta: string): void;
  /** Move accumulated reasoning into the transcript as a collapsed Thoughts block. */
  finalizeReasoning(): void;
  /** Discard accumulated reasoning without writing a transcript entry. */
  clearLiveThinking(): void;
  /**
   * Replace the input buffer contents (used for draft prefill on session:handoff
   * with autostart=false). Cursor lands at the end of the inserted text.
   */
  setInputDraft(text: string): void;
}

export interface CompletionItem {
  label: string;
  detail?: string;
  insertText: string;
  sortWeight?: number;
}

export interface CompletionSource {
  id: string;
  trigger: string;
  list(query: string): CompletionItem[] | Promise<CompletionItem[]>;
}

export interface TuiCompletionService {
  register(source: CompletionSource): () => void;
}

// Marker only; consumers may require this service name to assert wiring.
export interface TuiStatusService {}

export interface TuiThemeService {
  current(): TuiTheme;
}

export type { TuiTheme };
