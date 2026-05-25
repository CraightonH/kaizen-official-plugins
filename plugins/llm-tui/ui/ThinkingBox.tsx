import React from "react";
import { Box, Text } from "ink";
import { DEFAULT_CONFIG } from "../config.ts";

/**
 * Live thinking panel rendered between the spinner and the input box while
 * the underlying LLM emits reasoning deltas. Shows the tail of the stream
 * so the box stays a fixed visual size regardless of how long the model
 * thinks. Tail length is config-driven (`thinkingTailLines`); callers in
 * production read it from the snapshot, tests fall back to DEFAULT_CONFIG.
 */
export const ThinkingBox: React.FC<{ text: string; color: string; tailLines?: number }> = ({ text, color, tailLines }) => {
  const lines = text.split("\n");
  const tail = lines.slice(-(tailLines ?? DEFAULT_CONFIG.thinkingTailLines));
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1}>
      <Text color={color} dimColor>💭 Thinking…</Text>
      {tail.map((l, i) => (
        <Text key={i} color={color} dimColor>{l.length === 0 ? " " : l}</Text>
      ))}
    </Box>
  );
};
