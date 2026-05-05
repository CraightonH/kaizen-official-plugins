import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import { useSyncExternalStore } from "react";
import type { TuiStore } from "../state/store.ts";
import type { CompletionRegistry } from "../completion/registry.ts";
import type { TuiTheme } from "../theme/loader.ts";
import { CompletionPopup } from "./CompletionPopup.tsx";

export interface InputBoxProps {
  store: TuiStore;
  registry: CompletionRegistry;
  triggers: Set<string>;
  theme: TuiTheme;
  onSubmit: (text: string) => void;
  onCtrlC?: () => void;
}

// Naive linear scan: returns true if `pos` falls inside an unbalanced
// quote / backtick region starting from column 0.
function insideQuoteOrBacktick(line: string, pos: number): boolean {
  let inDouble = false;
  let inSingle = false;
  let inBack = false;
  for (let i = 0; i < pos; i++) {
    const ch = line[i];
    if (inBack) { if (ch === "`") inBack = false; continue; }
    if (inDouble) { if (ch === '"') inDouble = false; continue; }
    if (inSingle) { if (ch === "'") inSingle = false; continue; }
    if (ch === "`") inBack = true;
    else if (ch === '"') inDouble = true;
    else if (ch === "'") inSingle = true;
  }
  return inDouble || inSingle || inBack;
}

function atWordStart(line: string, pos: number): boolean {
  if (pos <= 0) return true;
  const prev = line[pos - 1];
  return prev === undefined || /\s/.test(prev);
}

export const InputBox: React.FC<InputBoxProps> = ({ store, registry, triggers, theme, onSubmit, onCtrlC }) => {
  const snap = useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => store.snapshot(),
  );
  const [histIdx, setHistIdx] = useState<number | null>(null);
  const queryToken = useRef(0);

  const popup = snap.popup;
  const value = snap.input.value;
  const cursor = snap.input.cursor;

  const refreshPopupItems = useCallback((trigger: string, q: string) => {
    const my = ++queryToken.current;
    void registry.query(trigger, q).then((items) => {
      if (my !== queryToken.current) return;
      // Only apply if the popup is still open with the same trigger.
      const cur = store.snapshot().popup;
      if (!cur || cur.trigger !== trigger) return;
      store.setPopupItems(items);
    });
  }, [registry, store]);

  // When popup query changes, refresh items.
  useEffect(() => {
    if (!popup) return;
    refreshPopupItems(popup.trigger, popup.query);
  }, [popup?.trigger, popup?.query, refreshPopupItems]);

  const setBuffer = useCallback((newValue: string, newCursor: number) => {
    store.setInput(newValue, newCursor);
    setHistIdx(null);
    // Update popup query if open.
    const cur = store.snapshot().popup;
    if (cur) {
      const tp = cur.triggerPos;
      if (newCursor <= tp || newValue[tp] !== cur.trigger) {
        store.closePopup();
      } else {
        const q = newValue.slice(tp + 1, newCursor);
        store.setPopupQuery(q);
      }
    }
  }, [store]);

  const acceptPopup = useCallback((): boolean => {
    const cur = store.snapshot().popup;
    if (!cur) return false;
    if (cur.items.length === 0) return false;
    const item = cur.items[cur.selectedIndex];
    if (!item) return false;
    const before = value.slice(0, cur.triggerPos);
    const after = value.slice(cursor);
    const next = before + item.insertText + after;
    const nextCursor = before.length + item.insertText.length;
    store.setInput(next, nextCursor);
    store.closePopup();
    return true;
  }, [store, value, cursor]);

  const submitLine = useCallback(() => {
    const line = value;
    store.setInput("", 0);
    store.closePopup();
    setHistIdx(null);
    onSubmit(line);
  }, [value, store, onSubmit]);

  useInput((input, key) => {
    if (key.ctrl && input === "c") { onCtrlC?.(); return; }

    if (key.escape) {
      if (popup) { store.closePopup(); return; }
      return;
    }

    // Newline-insert paths. Enter alone submits, but the user can request a
    // soft newline three ways:
    //   - Shift+Enter           — works when the terminal sends a distinct
    //                             code (kitty keyboard protocol, iTerm2 with
    //                             custom keymap). Stock macOS Terminal.app
    //                             sends \r either way and CANNOT be detected.
    //   - Option/Alt+Enter      — works on macOS in iTerm2/Terminal.app
    //                             (the meta flag is reliable).
    //   - Trailing backslash    — typing "\" then Enter is treated as a
    //                             "soft enter": the backslash is consumed
    //                             and a newline is inserted instead.
    const wantsNewline =
      (key.return && (key.shift || key.meta)) ||
      (key.return && cursor > 0 && value[cursor - 1] === "\\");

    if (key.return && !wantsNewline) {
      if (popup && popup.items.length > 0) { acceptPopup(); return; }
      if (popup && popup.items.length === 0) { store.closePopup(); submitLine(); return; }
      submitLine();
      return;
    }

    if (key.tab) {
      if (popup && popup.items.length > 0) { acceptPopup(); return; }
      return;
    }

    if (wantsNewline) {
      // Trailing-backslash path: replace the "\" with "\n" so it doesn't
      // remain in the message. Otherwise just splice a "\n" at the cursor.
      const trailingSlash = !key.shift && !key.meta;
      if (trailingSlash) {
        const next = value.slice(0, cursor - 1) + "\n" + value.slice(cursor);
        setBuffer(next, cursor);
      } else {
        const next = value.slice(0, cursor) + "\n" + value.slice(cursor);
        setBuffer(next, cursor + 1);
      }
      return;
    }

    if (key.backspace || key.delete) {
      if (cursor === 0) return;
      const next = value.slice(0, cursor - 1) + value.slice(cursor);
      setBuffer(next, cursor - 1);
      return;
    }

    if (key.leftArrow) {
      store.setInput(value, Math.max(0, cursor - 1));
      return;
    }
    if (key.rightArrow) {
      store.setInput(value, Math.min(value.length, cursor + 1));
      return;
    }

    if (key.upArrow) {
      if (popup) { store.movePopup(-1); return; }
      const hist = snap.history;
      if (hist.length === 0) return;
      const next = histIdx === null ? hist.length - 1 : Math.max(0, histIdx - 1);
      setHistIdx(next);
      const v = hist[next] ?? "";
      store.setInput(v, v.length);
      return;
    }
    if (key.downArrow) {
      if (popup) { store.movePopup(1); return; }
      if (histIdx === null) return;
      const hist = snap.history;
      const next = histIdx + 1;
      if (next >= hist.length) {
        setHistIdx(null);
        store.setInput("", 0);
      } else {
        setHistIdx(next);
        const v = hist[next] ?? "";
        store.setInput(v, v.length);
      }
      return;
    }

    // Ctrl chords (e.g. Ctrl+R toggling a Thoughts block) deliver the bare
    // letter as `input` alongside `key.ctrl`. Without this guard the letter
    // would also be inserted into the prompt buffer. Meta is intentionally
    // not blocked — on macOS Option produces special unicode like ´/ƒ and
    // some users actually want to type those.
    if (key.ctrl) return;

    if (input && input.length > 0) {
      // Process character by character to detect trigger characters embedded in
      // multi-char pastes (ink-testing-library sends multi-char strings as one event).
      let curVal = value;
      let curPos = cursor;
      let didOpenPopup = false;

      for (let i = 0; i < input.length; i++) {
        const ch = input[i]!;
        const next = curVal.slice(0, curPos) + ch + curVal.slice(curPos);
        const newCursor = curPos + 1;

        if (triggers.has(ch)) {
          const triggerPos = curPos; // position where the new char now sits
          const okWordStart = atWordStart(next, triggerPos);
          const okOutsideQuote = !insideQuoteOrBacktick(next, triggerPos);
          if (okWordStart && okOutsideQuote) {
            curVal = next;
            curPos = newCursor;
            store.setInput(curVal, curPos);
            setHistIdx(null);
            store.openPopup(ch, "", triggerPos);
            didOpenPopup = true;
            continue;
          }
        }

        // Regular char (or trigger at non-word-start/inside-quote): update buffer.
        curVal = next;
        curPos = newCursor;
        // If popup is open, update query or close if cursor passed trigger.
        const cur = store.snapshot().popup;
        if (cur) {
          const tp = cur.triggerPos;
          if (curPos <= tp || curVal[tp] !== cur.trigger) {
            store.setInput(curVal, curPos);
            setHistIdx(null);
            store.closePopup();
          } else {
            const q = curVal.slice(tp + 1, curPos);
            store.setInput(curVal, curPos);
            setHistIdx(null);
            store.setPopupQuery(q);
          }
        } else {
          store.setInput(curVal, curPos);
          setHistIdx(null);
        }
      }

      if (!didOpenPopup) {
        // Final state is already applied above; nothing more to do.
      }
    }
  });

  // Open-on-the-right framed prompt with embedded label, drawn manually so
  // the label sits in the top border instead of inside the box.
  const { stdout } = useStdout();
  const cols = Math.max(20, stdout?.columns ?? 80);
  const labelSeg = ` ${theme.promptLabel} `;
  const topPrefix = `╭───${labelSeg}`;
  const topLine = topPrefix + "─".repeat(Math.max(0, cols - topPrefix.length - 1));
  const bottomLine = "╰" + "─".repeat(Math.max(0, cols - 2));

  // Multiline-aware render. Map the flat cursor offset into (row, col) over
  // the value's logical lines, then render one row per line. The cursor is
  // a filled inverse-color block at its column on its row.
  const lines = value.split("\n");
  let cursorRow = 0;
  let cursorCol = cursor;
  for (let i = 0; i < lines.length; i++) {
    const len = lines[i]!.length;
    if (cursorCol <= len) { cursorRow = i; break; }
    cursorCol -= len + 1; // +1 for the consumed "\n"
    cursorRow = i + 1;
  }

  return (
    <Box flexDirection="column">
      <Text color={theme.promptColor}>{topLine}</Text>
      {lines.map((line, i) => {
        const prefix = i === 0 ? "│ ❯ " : "│   ";
        if (i !== cursorRow) {
          return (
            <Box key={i}>
              <Text color={theme.promptColor}>{prefix}</Text>
              <Text color={theme.outputColor}>{line.length === 0 ? " " : line}</Text>
            </Box>
          );
        }
        const before = line.slice(0, cursorCol);
        const at = line[cursorCol] ?? " ";
        const after = line.slice(cursorCol + 1);
        return (
          <Box key={i}>
            <Text color={theme.promptColor}>{prefix}</Text>
            <Text color={theme.outputColor}>{before}</Text>
            <Text color={theme.outputColor} inverse>{at}</Text>
            <Text color={theme.outputColor}>{after}</Text>
          </Box>
        );
      })}
      <Text color={theme.promptColor}>{bottomLine}</Text>
      {popup && <CompletionPopup popup={popup} noticeColor={theme.noticeColor} />}
    </Box>
  );
};
