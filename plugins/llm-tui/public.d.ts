import type { UiTheme } from "llm-contracts/public";

export type { UiChannelService, UiTheme, UiThemeService, UiStatusService, UiCompletionService, CompletionItem, CompletionSource, UiToolRenderer, UiToolRendererService, ToolCallStatus, ConfigStoreService } from "llm-contracts/public";
export type {
  UiPromptService,
  UiPromptOption,
  UiPromptOptionsRequest,
  UiPromptTextRequest,
} from "llm-contracts/public";

/**
 * Plugin-private config type for `llm-tui`. Extends `UiTheme` with non-theme
 * UX-density knobs. Only `llm-tui`'s own UI components read these — they do
 * not cross plugin boundaries, so the type stays here rather than on
 * `llm-contracts`. Defaults and schema live in `./config.ts`.
 */
export interface LlmTuiConfig extends UiTheme {
  completionDebounceMs: number;
  completionMaxVisible: number;
  ctrlCExitWindowMs: number;
  thinkingTailLines: number;
  agentActivityCap: number;
  toolPreviewChars: number;
  toolExpandedLineWidth: number;
  toolExpandedPreviewLines: number;
  toolFallbackJsonChars: number;
}

