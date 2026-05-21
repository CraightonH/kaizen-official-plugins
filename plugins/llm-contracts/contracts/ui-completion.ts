export const CONTRACT_ID = "ui:completion-source";
export const DESCRIPTION = "Registry of completion sources for input popups.";

export interface CompletionItem {
  label: string;
  detail?: string;
  insertText: string;
  sortWeight?: number;
}

export interface CompletionContext {
  line: string;
  cursor: number;
}

export interface CompletionSource {
  id: string;
  /**
   * Single-char activation. Set this OR `match`, not both. When set, the
   * popup opens on this char at a word-start outside quotes/backticks.
   */
  trigger?: string;
  /**
   * Predicate-based activation. Set this OR `trigger`, not both. The TUI
   * calls `match(line, cursor)` on every line/cursor change; a non-null
   * return opens (or keeps open) a popup pinned to this source.
   */
  match?: (line: string, cursor: number) => { triggerPos: number; query: string } | null;
  list(query: string, ctx?: CompletionContext): CompletionItem[] | Promise<CompletionItem[]>;
}

export interface UiCompletionService {
  register(source: CompletionSource): () => void;
}
