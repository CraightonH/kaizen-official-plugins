import React from "react";
import { Box, Text } from "ink";

/**
 * Collapsed Thoughts entry in the chat transcript. Always rendered
 * collapsed — once the entry is committed it goes through Ink's <Static>
 * and cannot change in place. Users review past thoughts via /history
 * (or Ctrl+R), which opens the audit view where blocks are toggleable.
 */
export const ThoughtsBlock: React.FC<{ text: string; color: string }> = ({ text, color }) => {
  const lineCount = text.split("\n").filter((l) => l.length > 0).length || 1;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1}>
      <Text color={color} dimColor>
        {`▶ 💭 Thoughts (${lineCount} line${lineCount === 1 ? "" : "s"})  — /history or Ctrl+R to review`}
      </Text>
    </Box>
  );
};
