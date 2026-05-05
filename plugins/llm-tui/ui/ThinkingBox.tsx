import React from "react";
import { Box, Text } from "ink";

const TAIL_LINES = 5;

/**
 * Live thinking panel rendered between the spinner and the input box while
 * the underlying LLM emits reasoning deltas. Shows the tail of the stream
 * so the box stays a fixed visual size regardless of how long the model
 * thinks.
 */
export const ThinkingBox: React.FC<{ text: string; color: string }> = ({ text, color }) => {
  const lines = text.split("\n");
  const tail = lines.slice(-TAIL_LINES);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1}>
      <Text color={color} dimColor>💭 Thinking…</Text>
      {tail.map((l, i) => (
        <Text key={i} color={color} dimColor>{l.length === 0 ? " " : l}</Text>
      ))}
    </Box>
  );
};
