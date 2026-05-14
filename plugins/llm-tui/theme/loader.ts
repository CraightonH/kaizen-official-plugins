import { readFile as fsReadFile } from "node:fs/promises";
import type { UiTheme } from "llm-contracts/public";

export type { UiTheme };
/** @deprecated Use UiTheme from llm-contracts/public */
export type TuiTheme = UiTheme;

export const DEFAULT_THEME: UiTheme = Object.freeze({
  promptLabel: "kaizen",
  promptColor: "magenta",
  outputColor: "white",
  noticeColor: "yellow",
  busyColor: "magenta",
  statusBarColor: "gray",
  thoughtsMarkdown: true,
});

export interface ThemeDeps {
  home: string;
  env: Record<string, string | undefined>;
  readFile: (path: string) => Promise<string>;
  log: (msg: string) => void;
  harnessDefaults?: Partial<UiTheme>;
}

export function defaultThemeConfigPath(home: string): string {
  return `${home}/.kaizen/plugins/llm-tui/config.json`;
}

const NAMED_COLORS = new Set([
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white", "gray", "grey",
  "blackBright", "redBright", "greenBright", "yellowBright", "blueBright", "magentaBright",
  "cyanBright", "whiteBright",
]);

function isValidColor(v: unknown): v is string {
  if (typeof v !== "string") return false;
  if (/^#[0-9a-fA-F]{6}$/.test(v)) return true;
  return NAMED_COLORS.has(v);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function pickValid(input: Record<string, unknown> | undefined, fallback: UiTheme): UiTheme {
  if (!input) return { ...fallback };
  const out: UiTheme = { ...fallback };
  if (typeof input.promptLabel === "string") out.promptLabel = input.promptLabel;
  if (isValidColor(input.promptColor)) out.promptColor = input.promptColor;
  if (isValidColor(input.outputColor)) out.outputColor = input.outputColor;
  if (isValidColor(input.noticeColor)) out.noticeColor = input.noticeColor;
  if (isValidColor(input.busyColor)) out.busyColor = input.busyColor;
  if (isValidColor(input.statusBarColor)) out.statusBarColor = input.statusBarColor;
  if (typeof input.thoughtsMarkdown === "boolean") out.thoughtsMarkdown = input.thoughtsMarkdown;
  return out;
}

export async function loadTheme(deps: ThemeDeps): Promise<UiTheme> {
  const path = deps.env.KAIZEN_LLM_TUI_CONFIG ?? defaultThemeConfigPath(deps.home);
  const withHarness = pickValid(deps.harnessDefaults as Record<string, unknown> | undefined, DEFAULT_THEME);

  let raw: string | null = null;
  try {
    raw = await deps.readFile(path);
  } catch (err: any) {
    if (err?.code === "ENOENT") return withHarness;
    deps.log(`llm-tui: cannot read theme config at ${path}: ${err?.message ?? err}; using defaults`);
    return withHarness;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    deps.log(`llm-tui: theme config at ${path} malformed: ${(err as Error).message}; using defaults`);
    return withHarness;
  }

  if (!isPlainObject(parsed)) return withHarness;
  const themeInput = isPlainObject(parsed.theme) ? parsed.theme : undefined;
  return pickValid(themeInput, withHarness);
}

export function realThemeDeps(log: (msg: string) => void, harnessDefaults?: Partial<UiTheme>): ThemeDeps {
  return {
    home: process.env.HOME ?? "/",
    env: process.env as Record<string, string | undefined>,
    readFile: (p) => fsReadFile(p, "utf8"),
    log,
    harnessDefaults,
  };
}
