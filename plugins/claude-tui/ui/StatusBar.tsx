import React from "react";
import { Box, Text } from "ink";
import type { StatusItem } from "../state/store.ts";

const toneColor = (tone?: StatusItem["tone"]): string | undefined => {
  if (tone === "warn") return "yellow";
  if (tone === "err") return "red";
  return undefined;
};

export const StatusBar: React.FC<{ items: Map<string, StatusItem> }> = ({ items }) => {
  if (items.size === 0) return null;
  const sorted = [...items.values()].sort((a, b) => (a.priority ?? 50) - (b.priority ?? 50));
  return (
    <Box>
      {sorted.map((it, i) => (
        <Box key={it.id}>
          {i > 0 && <Text dimColor> | </Text>}
          <Text color={toneColor(it.tone)} dimColor={!it.tone}>{it.text}</Text>
        </Box>
      ))}
    </Box>
  );
};
