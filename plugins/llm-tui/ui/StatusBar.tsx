import React from "react";
import { Box, Text } from "ink";

export const StatusBar: React.FC<{ items: Record<string, string>; color: string }> = ({ items, color }) => {
  const keys = Object.keys(items);
  if (keys.length === 0) return null;
  return (
    <Box>
      {keys.map((k, i) => {
        // Convention: keys starting with `_` render value-only — useful for
        // self-describing widgets (a context-window bar, a progress meter)
        // where the key would just be visual noise.
        const labelless = k.startsWith("_");
        return (
          <Box key={k}>
            {i > 0 && <Text color={color}> | </Text>}
            <Text color={color}>{labelless ? items[k] : `${k} ${items[k]}`}</Text>
          </Box>
        );
      })}
    </Box>
  );
};
