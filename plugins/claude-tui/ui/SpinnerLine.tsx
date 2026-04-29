import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";

export const SpinnerLine: React.FC<{ msg?: string }> = ({ msg }) => (
  <Box>
    <Text color="yellow">
      <Spinner type="dots" />
    </Text>
    <Text color="yellow">{` ${msg ?? "thinking…"}`}</Text>
  </Box>
);
