import React from "react";
import { Box, Text } from "ink";

/**
 * Collapsed-by-default Thoughts block rendered in the transcript between a
 * user turn and the assistant reply. Toggle the most recent block with
 * Ctrl+R.
 */
export const ThoughtsBlock: React.FC<{ text: string; expanded: boolean; color: string }> = ({ text, expanded, color }) => {
  const lineCount = text.split("\n").filter((l) => l.length > 0).length || 1;
  const caret = expanded ? "▼" : "▶";
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1}>
      <Text color={color} dimColor>
        {`${caret} 💭 Thoughts (${lineCount} line${lineCount === 1 ? "" : "s"})${expanded ? "" : "  — Ctrl+R to expand"}`}
      </Text>
      {expanded && (
        <Box flexDirection="column" marginTop={0}>
          {text.split("\n").map((l, i) => (
            <Text key={i} color={color} dimColor>{l.length === 0 ? " " : l}</Text>
          ))}
        </Box>
      )}
    </Box>
  );
};
