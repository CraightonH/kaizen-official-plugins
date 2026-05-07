import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import type { ToolCallEntry } from "../state/store.ts";
import type { ToolRendererRegistry } from "../tool-renderers/registry.ts";
import type { TuiTheme } from "../theme/loader.ts";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MAX_PREVIEW = 60;

function defaultCollapsedSummary(args: unknown): string {
  let s: string;
  try { s = JSON.stringify(args ?? {}); } catch { s = String(args); }
  if (s.length > MAX_PREVIEW) s = `${s.slice(0, MAX_PREVIEW - 1)}…`;
  return s;
}

export interface ToolCallBlockProps {
  entry: ToolCallEntry;
  registry: ToolRendererRegistry;
  theme: TuiTheme;
}

export const ToolCallBlock: React.FC<ToolCallBlockProps> = ({ entry, registry, theme }) => {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (entry.status !== "running") return;
    const t = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(t);
  }, [entry.status]);

  const renderer = registry.lookup(entry.name);
  const summary = renderer ? renderer.collapsedSummary(entry.args) : defaultCollapsedSummary(entry.args);

  let glyph: string;
  let glyphColor = theme.outputColor;
  if (entry.status === "running") { glyph = SPINNER_FRAMES[frame]!; glyphColor = theme.busyColor; }
  else if (entry.status === "done") { glyph = "✓"; glyphColor = theme.outputColor; }
  else { glyph = "✗"; glyphColor = theme.noticeColor; }

  const trail =
    entry.status === "error" && entry.errorMessage ? ` — ${entry.errorMessage}` :
    entry.status === "done" && entry.result ? ` — ${truncate(entry.result, 40)}` :
    "";

  return (
    <Text>
      <Text color={theme.promptColor}>{"▸ "}</Text>
      <Text color={theme.promptColor} bold>{entry.name}</Text>
      <Text color={theme.outputColor}>{"  "}</Text>
      <Text color={theme.outputColor} dimColor>{summary}</Text>
      <Text color={glyphColor}>{`  ${glyph}`}</Text>
      <Text color={theme.outputColor} dimColor>{trail}</Text>
    </Text>
  );
};

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}
