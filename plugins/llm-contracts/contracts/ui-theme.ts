export const CONTRACT_ID = "ui:theme";
export const DESCRIPTION = "Read-only UI theme tokens.";

export interface UiTheme {
  promptLabel: string;
  promptColor: string;
  outputColor: string;
  noticeColor: string;
  busyColor: string;
  statusBarColor: string;
  /**
   * Render expanded thoughts in HistoryView through the markdown renderer.
   * The live ThinkingBox is always plain regardless of this flag.
   * Default: true.
   */
  thoughtsMarkdown: boolean;
}

export interface UiThemeService {
  current(): UiTheme;
}
