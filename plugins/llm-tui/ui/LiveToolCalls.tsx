import React, { useSyncExternalStore } from "react";
import { Box, Text } from "ink";
import type { TuiStore } from "../state/store.ts";
import type { ToolRendererRegistry } from "../tool-renderers/registry.ts";
import type { UiTheme } from "llm-contracts/public";
import { ToolCallBlock } from "./ToolCallBlock.tsx";

export interface LiveToolCallsProps {
  store: TuiStore;
  registry: ToolRendererRegistry;
  theme: UiTheme;
}

/**
 * Renders the in-flight tool calls. Lives OUTSIDE the App's <Static> wrapper
 * so each frame can repaint as stdout streams in and status transitions.
 */
export const LiveToolCalls: React.FC<LiveToolCallsProps> = ({ store, registry, theme }) => {
  const snap = useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => store.snapshot(),
  );

  if (snap.liveToolCalls.size === 0) return null;

  return (
    <Box flexDirection="column">
      {[...snap.liveToolCalls.values()].map((entry) => (
        <Box key={entry.callId} flexDirection="column">
          <ToolCallBlock entry={entry} registry={registry} theme={theme} />
          {entry.stdout && (
            <Box flexDirection="column" paddingLeft={2}>
              {entry.stdout.split("\n").map((line, i) => (
                <Text key={i} color={theme.outputColor} dimColor>{line.length === 0 ? " " : line}</Text>
              ))}
            </Box>
          )}
        </Box>
      ))}
    </Box>
  );
};
