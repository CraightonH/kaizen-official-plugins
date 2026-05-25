import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import type { ToolCallEntry } from "../state/store.ts";
import type { ToolRendererRegistry } from "../tool-renderers/registry.ts";
import type { UiTheme } from "llm-contracts/public";
import { defaultCollapsedSummary, defaultResultPreview } from "../tool-renderers/util.ts";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface ToolCallBlockProps {
  entry: ToolCallEntry;
  registry: ToolRendererRegistry;
  theme: UiTheme;
  /**
   * Char cap for the one-line preview text rendered alongside the tool's
   * collapsed summary. Optional so existing tests can keep passing this
   * component without threading config through; falls back to the
   * DEFAULT_CONFIG.toolPreviewChars baked into util.ts.
   */
  previewMax?: number;
}

export const ToolCallBlock: React.FC<ToolCallBlockProps> = ({ entry, registry, theme, previewMax }) => {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (entry.status !== "running") return;
    const t = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(t);
  }, [entry.status]);

  const renderer = registry.lookup(entry.name);
  const summary = renderer ? renderer.collapsedSummary(entry.args) : defaultCollapsedSummary(entry.args, previewMax);

  let glyph: string;
  let glyphColor = theme.outputColor;
  if (entry.status === "running") { glyph = SPINNER_FRAMES[frame]!; glyphColor = theme.busyColor; }
  else if (entry.status === "done") { glyph = "✓"; glyphColor = theme.outputColor; }
  else { glyph = "✗"; glyphColor = theme.noticeColor; }

  const expanded =
    renderer && renderer.expandedView && entry.status !== "running"
      ? renderer.expandedView(entry.args, entry.result, entry.status, entry.stdout)
      : null;

  const activity = entry.agentActivity ?? [];
  const hasActivity = activity.length > 0;

  // Suppress the success trail when an expansion or agent activity is present
  // — the ⎿ block already shows the same content, more legibly. Errors keep
  // the trail (errorMessage) since the expansion is usually null for error cases.
  const resultPreview = entry.status === "done" && !expanded && !hasActivity
    ? (entry.stdout && entry.stdout.length > 0 ? defaultResultPreview(entry.stdout, previewMax) : defaultResultPreview(entry.result, previewMax))
    : "";
  const trail =
    entry.status === "error" && entry.errorMessage ? ` — ${entry.errorMessage}` :
    resultPreview ? ` — ${resultPreview}` :
    "";

  const header = (
    <Text>
      <Text color={theme.promptColor}>{"▸ "}</Text>
      <Text color={theme.promptColor} bold>{entry.name}</Text>
      <Text color={theme.outputColor} dimColor>{`(${summary})`}</Text>
      <Text color={glyphColor}>{`  ${glyph}`}</Text>
      <Text color={theme.outputColor} dimColor>{trail}</Text>
    </Text>
  );

  if (!expanded && !hasActivity) return header;

  return (
    <Box flexDirection="column">
      {header}
      {hasActivity && (
        <Box flexDirection="row">
          <Text color={theme.outputColor} dimColor>{"  ⎿  "}</Text>
          <Box flexDirection="column">
            {activity.map((line, i) => (
              <Text key={i} color={theme.outputColor} dimColor>{line}</Text>
            ))}
          </Box>
        </Box>
      )}
      {expanded && (
        <Box flexDirection="row">
          <Text color={theme.outputColor} dimColor>{"  ⎿  "}</Text>
          <Box flexDirection="column">{expanded}</Box>
        </Box>
      )}
    </Box>
  );
};
