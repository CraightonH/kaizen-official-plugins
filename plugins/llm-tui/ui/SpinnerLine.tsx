import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";

interface SpinnerLineProps {
  color: string;
  message?: string;
  startedAt?: number;
  deltaTokens?: number;
}

function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return min > 0 ? `${min}m ${sec}s` : `${sec}s`;
}

export const SpinnerLine: React.FC<SpinnerLineProps> = ({
  color, message, startedAt, deltaTokens,
}) => {
  // The store only emits when token count changes, but elapsed time advances
  // every second on its own. Force a re-render once per second while a busy
  // period is active so the displayed duration ticks live.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!startedAt) return;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  let suffix = "";
  if (startedAt) {
    const elapsed = Date.now() - startedAt;
    const tokens = deltaTokens ?? 0;
    suffix = ` (${formatDuration(elapsed)} · ↓ ${tokens} tokens) * Esc to interrupt`;
  }
  return (
    <Box>
      <Text color={color}>
        <Spinner type="dots" />
      </Text>
      <Text color={color}>{` ${message ?? "thinking"}${suffix}`}</Text>
    </Box>
  );
};
