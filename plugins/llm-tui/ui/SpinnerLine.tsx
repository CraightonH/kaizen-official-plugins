import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";

export const SpinnerLine: React.FC<{ color: string; message?: string }> = ({ color, message }) => (
  <Box>
    <Text color={color}>
      <Spinner type="dots" />
    </Text>
    <Text color={color}>{` ${message ?? "thinking"}`}</Text>
  </Box>
);
