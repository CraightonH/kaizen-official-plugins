import React from "react";
import { Box, Text } from "ink";
import type { PopupState } from "../state/store.ts";
import { DEFAULT_CONFIG } from "../config.ts";

export const CompletionPopup: React.FC<{ popup: PopupState; noticeColor: string; maxVisible?: number }> = ({ popup, noticeColor, maxVisible }) => {
  if (popup.items.length === 0) {
    return (
      <Box>
        <Text color={noticeColor}>no matches</Text>
      </Box>
    );
  }

  // Window the visible items around the selected index, anchored at top.
  const cap = maxVisible ?? DEFAULT_CONFIG.completionMaxVisible;
  const total = popup.items.length;
  const start = Math.min(Math.max(0, popup.selectedIndex - (cap - 1)), Math.max(0, total - cap));
  const end = Math.min(total, start + cap);
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
