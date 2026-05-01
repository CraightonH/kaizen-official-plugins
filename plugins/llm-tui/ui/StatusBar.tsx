import React from "react";
import { Box, Text } from "ink";

export const StatusBar: React.FC<{ items: Record<string, string>; color: string }> = ({ items, color }) => {
  const keys = Object.keys(items);
  if (keys.length === 0) return null;
  return (
    <Box>
      {keys.map((k, i) => (
        <Box key={k}>
          {i > 0 && <Text color={color}> | </Text>}
          <Text color={color}>{`${k} ${items[k]}`}</Text>
        </Box>
      ))}
    </Box>
  );
};
