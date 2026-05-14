export const CONTRACT_ID = "ui:channel";
export const DESCRIPTION = "Pull-style chat I/O channel between driver and UI.";

export interface WriteOptions {
  /**
   * Render `text` as markdown before display.
   * Default depends on the method:
   *   writeOutput → true  (back-compat with current always-on rendering)
   *   writeNotice → false
   *   writeUser   → false
   * When false, text is rendered verbatim. When true, text is run through
   * the TUI's markdown renderer (marked + marked-terminal) which emits ANSI
   * suitable for Ink <Text> or stdout.
   */
  markdown?: boolean;
}

export interface UiChannelService {
  writeOutput(chunk: string, opts?: WriteOptions): void;
  writeNotice(text: string, opts?: WriteOptions): void;
  /**
   * Append a user-authored message to the transcript. Rendered with the
   * prompt accent (magenta `❯` gutter + subtle background highlight) so
   * it visually anchors the start of a turn against the assistant reply.
   */
  writeUser(text: string, opts?: WriteOptions): void;
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
