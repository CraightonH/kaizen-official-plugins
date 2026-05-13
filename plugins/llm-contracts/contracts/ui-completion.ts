export const CONTRACT_ID = "ui:completion-source";
export const DESCRIPTION = "Registry of completion sources for input popups.";

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

export interface UiCompletionService {
  register(source: CompletionSource): () => void;
}
