import type { ConfigSchema, UiTheme } from "llm-contracts/public";

/**
 * Accepts a `#RRGGBB` hex color or any of Ink's named colors (matching Ink's
 * named-color set).
 */
export const COLOR_PATTERN =
  "^(#[0-9a-fA-F]{6}|black|red|green|yellow|blue|magenta|cyan|white|gray|grey|" +
  "blackBright|redBright|greenBright|yellowBright|blueBright|magentaBright|" +
  "cyanBright|whiteBright)$";

export const BUILT_IN_THEME: UiTheme = Object.freeze({
  promptLabel: "kaizen",
  promptColor: "magenta",
  outputColor: "white",
  noticeColor: "yellow",
  busyColor: "magenta",
  statusBarColor: "gray",
  thoughtsMarkdown: true,
}) as UiTheme;

export const THEME_SCHEMA: ConfigSchema<UiTheme> = {
  promptLabel:      { type: "string", min: 1, max: 32 },
  promptColor:      { type: "string", pattern: COLOR_PATTERN },
  outputColor:      { type: "string", pattern: COLOR_PATTERN },
  noticeColor:      { type: "string", pattern: COLOR_PATTERN },
  busyColor:        { type: "string", pattern: COLOR_PATTERN },
  statusBarColor:   { type: "string", pattern: COLOR_PATTERN },
  thoughtsMarkdown: { type: "boolean" },
};
