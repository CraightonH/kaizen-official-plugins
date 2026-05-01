import React from "react";
import { Box, Text } from "ink";
import type { PopupState } from "../state/store.ts";

const MAX_VISIBLE = 8;

export const CompletionPopup: React.FC<{ popup: PopupState; noticeColor: string }> = ({ popup, noticeColor }) => {
  if (popup.items.length === 0) {
    return (
      <Box>
        <Text color={noticeColor}>no matches</Text>
      </Box>
    );
  }

  // Window the visible items around the selected index, anchored at top.
  const total = popup.items.length;
  const start = Math.min(Math.max(0, popup.selectedIndex - (MAX_VISIBLE - 1)), Math.max(0, total - MAX_VISIBLE));
  const end = Math.min(total, start + MAX_VISIBLE);
  const visible = popup.items.slice(start, end);
  const hidden = total - visible.length;

  return (
    <Box flexDirection="column">
      {visible.map((it, i) => {
        const idx = start + i;
        const selected = idx === popup.selectedIndex;
        return (
          <Box key={`${it.label}:${idx}`}>
            <Text color={selected ? "cyan" : undefined} bold={selected}>
              {selected ? "› " : "  "}
              {it.label}
            </Text>
            {it.detail && (
              <Text dimColor>{`  ${it.detail}`}</Text>
            )}
          </Box>
        );
      })}
      {hidden > 0 && (
        <Text dimColor>{`… ${hidden} more`}</Text>
      )}
    </Box>
  );
};
