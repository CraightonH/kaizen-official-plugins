export interface UiPromptOption {
  id: string;
  label: string;
  /**
   * If set, Tab on this option expands an inline text field; Enter then
   * submits with both the option id and the typed text. Esc collapses back
   * to the option list (text is discarded).
   */
  expandsTo?: { kind: "text"; placeholder?: string; defaultValue?: string };
}

export interface UiPromptOptionsRequest {
  title: string;
  body: string;
  options: ReadonlyArray<UiPromptOption>;
  /** Initial selection id; defaults to options[0].id. */
  defaultId?: string;
  /** Esc at the top level resolves with this id; defaults to options.at(-1).id. */
  cancelId?: string;
}

export interface UiPromptTextRequest {
  title: string;
  body?: string;
  placeholder?: string;
  defaultValue?: string;
}

export interface UiPromptService {
  /** Resolves to { id } unless the chosen option expanded a text field. */
  requestOption(req: UiPromptOptionsRequest): Promise<{ id: string; text?: string }>;
  /** Standalone text prompt. Esc → empty string. */
  requestText(req: UiPromptTextRequest): Promise<string>;
}

export const CONTRACT_ID = "ui:prompt" as const;
export const DESCRIPTION = "Modal prompt above the input box for option choices and free-form text.";
