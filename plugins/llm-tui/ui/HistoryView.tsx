import React, { useSyncExternalStore } from "react";
import { Box, Text, useInput } from "ink";
import type { PlainTranscriptLine, ToolCallEntry, TuiStore, TranscriptLine } from "../state/store.ts";
import type { UiTheme } from "llm-contracts/public";
import { renderMarkdown } from "./markdown.ts";

export interface HistoryViewProps {
  store: TuiStore;
  theme: UiTheme;
}

type ThoughtsEntry = PlainTranscriptLine & { kind: "thoughts" };
type HistoryEntry = ThoughtsEntry | ToolCallEntry;

function isHistoryEntry(entry: TranscriptLine): entry is HistoryEntry {
  return entry.kind === "thoughts" || entry.kind === "tool_call";
}

// Memo keyed by transcript entry id. Entries are immutable once committed
// (see TuiStore snapshot identity invariant), so a per-id cache never needs
// invalidation. Survives expand/collapse cycles within the session.
const renderedThoughtsCache = new Map<number, string>();

function getRenderedThoughts(id: number, text: string): string {
  const cached = renderedThoughtsCache.get(id);
  if (cached !== undefined) return cached;
  const out = renderMarkdown(text);
  renderedThoughtsCache.set(id, out);
  return out;
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

  const blocks = snap.transcript.filter(isHistoryEntry);
  const focusedId = blocks[snap.historyView.focusIdx]?.id ?? null;
  const expanded = snap.historyView.expanded;

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" borderStyle="round" borderColor={theme.promptColor} paddingX={1}>
        <Text color={theme.promptColor} bold>
          📜 History — {blocks.length} entr{blocks.length === 1 ? "y" : "ies"}
        </Text>
        <Text color={theme.promptColor} dimColor>
          j/k focus · Enter expand · e all · c none · q quit
        </Text>
      </Box>

      {blocks.length === 0 ? (
        <Text color={theme.outputColor} dimColor>(no entries yet)</Text>
      ) : (
        blocks.map((e, i) => {
          const isFocused = e.id === focusedId;
          const isOpen = expanded.has(e.id);
          const caret = isOpen ? "▼" : "▶";
          const focusMarker = isFocused ? "▎ " : "  ";
          if (e.kind === "thoughts") {
            const lineCount = e.text.split("\n").filter((l) => l.length > 0).length || 1;
            const renderMd = theme.thoughtsMarkdown;
            return (
              <Box key={e.id} flexDirection="column" borderStyle={isFocused ? "double" : "round"}
                   borderColor={isFocused ? theme.promptColor : theme.noticeColor} paddingX={1}>
                <Text color={isFocused ? theme.promptColor : theme.noticeColor} dimColor={!isFocused}>
                  {`${focusMarker}${caret} 💭 Thoughts ${i + 1} (${lineCount} line${lineCount === 1 ? "" : "s"})`}
                </Text>
                {isOpen && renderMd && (
                  <Text color={theme.noticeColor}>{getRenderedThoughts(e.id, e.text)}</Text>
                )}
                {isOpen && !renderMd && (
                  <Box flexDirection="column">
                    {e.text.split("\n").map((l, j) => (
                      <Text key={j} color={theme.noticeColor} dimColor>{l.length === 0 ? " " : l}</Text>
                    ))}
                  </Box>
                )}
              </Box>
            );
          }
          // tool_call
          const status = e.status === "running" ? "…" : e.status === "done" ? "✓" : "✗";
          return (
            <Box key={e.id} flexDirection="column" borderStyle={isFocused ? "double" : "round"}
                 borderColor={isFocused ? theme.promptColor : theme.noticeColor} paddingX={1}>
              <Text color={isFocused ? theme.promptColor : theme.noticeColor} dimColor={!isFocused}>
                {`${focusMarker}${caret} 🔧 ${e.name} ${status}`}
              </Text>
              {isOpen && (
                <Box flexDirection="column">
                  <Text color={theme.outputColor} dimColor>args: {safeJson(e.args)}</Text>
                  {e.stdout && <Text color={theme.outputColor} dimColor>stdout:</Text>}
                  {e.stdout && e.stdout.split("\n").map((l, j) => (
                    <Text key={`s${j}`} color={theme.outputColor} dimColor>{l.length === 0 ? " " : l}</Text>
                  ))}
                  {e.result && <Text color={theme.outputColor} dimColor>result: {e.result}</Text>}
                  {e.errorMessage && <Text color={theme.noticeColor}>error: {e.errorMessage}</Text>}
                </Box>
              )}
            </Box>
          );
        })
      )}
    </Box>
  );
};

function safeJson(v: unknown): string {
  try { return JSON.stringify(v); } catch { return String(v); }
}
