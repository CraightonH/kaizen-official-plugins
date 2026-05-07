import React, { useSyncExternalStore } from "react";
import { Box, Text, useInput } from "ink";
import type { TuiStore, TranscriptLine } from "../state/store.ts";
import type { TuiTheme } from "../theme/loader.ts";

export interface HistoryViewProps {
  store: TuiStore;
  theme: TuiTheme;
}

/**
 * Audit panel rendered below the static transcript when viewMode is
 * "history". Lists the thought blocks of the current session. j/k focuses,
 * Enter expands the focused block, e/c expand or collapse all, q/Esc returns
 * to chat. The chat transcript itself is already visible in scrollback above
 * (Static); this panel only adds the toggleable thought-block UI on top.
 */
export const HistoryView: React.FC<HistoryViewProps> = ({ store, theme }) => {
  const snap = useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => store.snapshot(),
  );

  useInput((input, key) => {
    if (key.escape || input === "q") { store.exitHistoryMode(); return; }
    if (input === "j" || key.downArrow) { store.historyMoveFocus(1); return; }
    if (input === "k" || key.upArrow)   { store.historyMoveFocus(-1); return; }
    if (key.return)                     { store.historyToggleFocused(); return; }
    if (input === "e")                  { store.historySetAllExpanded(true); return; }
    if (input === "c")                  { store.historySetAllExpanded(false); return; }
  });

  const blocks = snap.transcript.filter((e: TranscriptLine) => e.kind === "thoughts");
  const focusedId = blocks[snap.historyView.focusIdx]?.id ?? null;
  const expanded = snap.historyView.expanded;

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" borderStyle="round" borderColor={theme.promptColor} paddingX={1}>
        <Text color={theme.promptColor} bold>
          📜 History — {blocks.length} thought block{blocks.length === 1 ? "" : "s"}
        </Text>
        <Text color={theme.promptColor} dimColor>
          j/k focus · Enter expand · e all · c none · q quit
        </Text>
      </Box>

      {blocks.length === 0 ? (
        <Text color={theme.outputColor} dimColor>(no thought blocks yet)</Text>
      ) : (
        blocks.map((e, i) => {
          const isFocused = e.id === focusedId;
          const isOpen = expanded.has(e.id);
          const lineCount = e.text.split("\n").filter((l) => l.length > 0).length || 1;
          const caret = isOpen ? "▼" : "▶";
          const focusMarker = isFocused ? "▎ " : "  ";
          return (
            <Box
              key={e.id}
              flexDirection="column"
              borderStyle={isFocused ? "double" : "round"}
              borderColor={isFocused ? theme.promptColor : theme.noticeColor}
              paddingX={1}
            >
              <Text color={isFocused ? theme.promptColor : theme.noticeColor} dimColor={!isFocused}>
                {`${focusMarker}${caret} 💭 Block ${i + 1} (${lineCount} line${lineCount === 1 ? "" : "s"})`}
              </Text>
              {isOpen && (
                <Box flexDirection="column">
                  {e.text.split("\n").map((l, j) => (
                    <Text key={j} color={theme.noticeColor} dimColor>{l.length === 0 ? " " : l}</Text>
                  ))}
                </Box>
              )}
            </Box>
          );
        })
      )}
    </Box>
  );
};
