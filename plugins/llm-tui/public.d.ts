export type { TuiToolRendererService, TuiToolRenderer } from "./tool-renderers/registry";
export type { ToolCallStatus } from "./state/store";

export type { UiChannelService, UiTheme, UiThemeService, UiStatusService } from "llm-contracts/public";

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

