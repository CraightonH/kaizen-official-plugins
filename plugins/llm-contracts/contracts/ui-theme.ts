export const CONTRACT_ID = "ui:theme";
export const DESCRIPTION = "Read-only UI theme tokens.";

export interface UiTheme {
  promptLabel: string;
  promptColor: string;
  outputColor: string;
  noticeColor: string;
  busyColor: string;
  statusBarColor: string;
}

export interface UiThemeService {
  current(): UiTheme;
}
