import type { TuiTheme } from "./theme/loader.ts";

export interface TuiChannelService {
  writeOutput(chunk: string): void;
  writeNotice(text: string): void;
  setBusy(state: boolean, message?: string): void;
  readInput(): Promise<string>;
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
