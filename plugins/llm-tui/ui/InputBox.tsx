import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useInput, usePaste, useStdout } from "ink";
import { useSyncExternalStore } from "react";
import type { TuiStore } from "../state/store.ts";
import type { CompletionRegistry } from "../completion/registry.ts";
import type { TuiTheme } from "../theme/loader.ts";
import type { CopyResult } from "../clipboard.ts";
import type { CompletionSource } from "llm-contracts/public";
import { CompletionPopup } from "./CompletionPopup.tsx";

export interface InputBoxProps {
  store: TuiStore;
  registry: CompletionRegistry;
  sources: Map<string, CompletionSource>;
  theme: TuiTheme;
  onSubmit: (text: string) => void;
  onCancel?: () => void;
  onExit?: () => void;
  /** Injected clipboard function; defaults to a no-op stub in non-TTY tests. */
  copyToClipboard?: (text: string) => Promise<CopyResult>;
}

// Window during which a second Ctrl+C exits. After this, the next press
// re-arms instead of exiting — matches Claude Code's behavior.
const CTRL_C_EXIT_WINDOW_MS = 2000;

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

const isWordChar = (ch: string | undefined) => !!ch && /\w/.test(ch);

// Bash/readline-style word jump: skip non-word chars then word chars going left.
function prevWordPos(s: string, pos: number): number {
  let i = pos;
  while (i > 0 && !isWordChar(s[i - 1])) i--;
  while (i > 0 && isWordChar(s[i - 1])) i--;
  return i;
}

function nextWordPos(s: string, pos: number): number {
  let i = pos;
  while (i < s.length && !isWordChar(s[i])) i++;
  while (i < s.length && isWordChar(s[i])) i++;
  return i;
}

// Line bounds for the (multi-line) buffer split by "\n".
function lineStartPos(s: string, pos: number): number {
  const nl = s.lastIndexOf("\n", pos - 1);
  return nl < 0 ? 0 : nl + 1;
}

function lineEndPos(s: string, pos: number): number {
  const nl = s.indexOf("\n", pos);
  return nl < 0 ? s.length : nl;
}

// Paste placeholder pattern. Kept identical to TuiStore.resolvePastes() so
// any form the user can submit is also recognized as an atomic edit unit.
const PLACEHOLDER_RE = /\[Pasted text #\d+ \+\d+ lines?\]/g;

function placeholderEndingAt(s: string, pos: number): { start: number; end: number } | null {
  PLACEHOLDER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PLACEHOLDER_RE.exec(s)) !== null) {
    const end = m.index + m[0].length;
    if (end === pos) return { start: m.index, end };
    if (m.index >= pos) break;
  }
  return null;
}

// True if `pos` falls strictly inside (not on either edge of) a placeholder.
function placeholderContaining(s: string, pos: number): { start: number; end: number } | null {
  PLACEHOLDER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PLACEHOLDER_RE.exec(s)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (pos > start && pos < end) return { start, end };
    if (start >= pos) break;
  }
  return null;
}

// Snap `pos` out of any placeholder it falls inside, to the edge implied by
// the direction of motion. Used so a single Left/Right step (or word jump)
// crosses a placeholder atomically instead of landing inside it.
function snapCursor(s: string, pos: number, direction: -1 | 1): number {
  const ph = placeholderContaining(s, pos);
  if (!ph) return pos;
  return direction < 0 ? ph.start : ph.end;
}

export const InputBox: React.FC<InputBoxProps> = ({ store, registry, sources, theme, onSubmit, onCancel, onExit, copyToClipboard }) => {
  const snap = useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => store.snapshot(),
  );
  const [histIdx, setHistIdx] = useState<number | null>(null);
  const queryToken = useRef(0);
  // Tracks the timestamp of the last Ctrl+C press so a second press within
  // CTRL_C_EXIT_WINDOW_MS triggers a real exit instead of re-arming. The
  // armed state also drives a transient hint rendered below the input box;
  // it's React state (not a transcript notice) so it disappears cleanly
  // when the window expires instead of becoming a permanent scrollback
  // line that lies after the timeout.
  const [ctrlCArmed, setCtrlCArmed] = useState(false);
  const ctrlCTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Cleanup any pending arm timer on unmount.
  useEffect(() => () => { if (ctrlCTimer.current) clearTimeout(ctrlCTimer.current); }, []);

  const charTriggers = React.useMemo(() => {
    const m = new Map<string, CompletionSource>();
    for (const s of sources.values()) {
      if (s.trigger) m.set(s.trigger, s);
    }
    return m;
  }, [sources]);

  const popup = snap.popup;
  const value = snap.input.value;
  const cursor = snap.input.cursor;

  const refreshPopupItems = useCallback((trigger: string | undefined, q: string) => {
    if (!trigger) return;
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
      const tp = cur.anchor;
      if (cur.trigger !== undefined) {
        // Char-triggered popup: close when cursor moves before anchor or trigger char is deleted.
        if (newCursor <= tp || newValue[tp] !== cur.trigger) {
          store.closePopup();
        } else {
          const q = newValue.slice(tp + 1, newCursor);
          store.setPopupQuery(q);
        }
      }
      // Match-based path will be handled in Task 7.
    }
  }, [store]);

  const acceptPopup = useCallback((): boolean => {
    const cur = store.snapshot().popup;
    if (!cur) return false;
    if (cur.items.length === 0) return false;
    const item = cur.items[cur.selectedIndex];
    if (!item) return false;
    const before = value.slice(0, cur.anchor);
    const after = value.slice(cursor);
    const next = before + item.insertText + after;
    const nextCursor = before.length + item.insertText.length;
    store.setInput(next, nextCursor);
    store.closePopup();
    return true;
  }, [store, value, cursor]);

  const submitLine = useCallback(() => {
    // Expand any [Pasted text #N +M lines] placeholders back to the actual
    // pasted content before handing the line to the consumer.
    const line = store.resolvePastes(value);
    store.setInput("", 0);
    store.closePopup();
    store.clearPastes();
    setHistIdx(null);
    onSubmit(line);
  }, [value, store, onSubmit]);

  // Ink's usePaste activates bracketed paste mode automatically and
  // delivers the full pasted text as a single string on its own channel,
  // so newlines inside the paste no longer reach useInput as Enter
  // keypresses. We register the content with the store, then insert a
  // short "[Pasted text #N +M lines]" placeholder at the cursor.
  // resolvePastes() expands these back to original text on submit.
  usePaste((text) => {
    const { placeholder } = store.registerPaste(text);
    const next = value.slice(0, cursor) + placeholder + value.slice(cursor);
    setBuffer(next, cursor + placeholder.length);
  });

  useInput((input, key) => {
    const prompt = snap.prompt;
    if (prompt) {
      if (prompt.kind === "options" && !prompt.expanded) {
        if (key.upArrow) { store.moveSelection(-1); return; }
        if (key.downArrow) { store.moveSelection(1); return; }
        if (key.return) {
          store.submitPrompt({ id: prompt.request.options[prompt.selectedIndex]!.id });
          return;
        }
        if (key.tab) { store.tabExpand(); return; }
        if (key.escape) { store.escapePrompt(); return; }
        return;
      }
      if (prompt.kind === "options" && prompt.expanded) {
        if (key.return) {
          store.submitPrompt({ id: prompt.expanded.id, text: prompt.expanded.text });
          return;
        }
        if (key.escape) { store.collapseExpansion(); return; }
        if (key.backspace || key.delete) {
          store.setExpandedText(prompt.expanded.text.slice(0, -1));
          return;
        }
        if (input && !key.ctrl && !key.meta) {
          store.setExpandedText(prompt.expanded.text + input);
          return;
        }
        return;
      }
      if (prompt.kind === "text") {
        if (key.return) { store.submitPrompt(prompt.text); return; }
        if (key.escape) { store.submitPrompt(""); return; }
        if (key.backspace || key.delete) {
          store.setStandaloneText(prompt.text.slice(0, -1));
          return;
        }
        if (input && !key.ctrl && !key.meta) {
          store.setStandaloneText(prompt.text + input);
          return;
        }
        return;
      }
    }
    // existing input handling continues below unchanged
    // Ctrl+C: two-step exit, modeled on Claude Code. First press shows a
    // hint (and cancels any in-flight turn / clears a non-empty buffer);
    // a second press within CTRL_C_EXIT_WINDOW_MS unmounts and exits.
    // Ink's exitOnCtrlC is disabled at render() so this handler owns it.
    if (key.ctrl && input === "c") {
      if (ctrlCArmed) {
        if (ctrlCTimer.current) { clearTimeout(ctrlCTimer.current); ctrlCTimer.current = null; }
        setCtrlCArmed(false);
        onExit?.();
        return;
      }
      if (ctrlCTimer.current) clearTimeout(ctrlCTimer.current);
      ctrlCTimer.current = setTimeout(() => { setCtrlCArmed(false); ctrlCTimer.current = null; }, CTRL_C_EXIT_WINDOW_MS);
      setCtrlCArmed(true);
      // Cancel an in-flight turn and clear any pending input buffer so the
      // user starts from a clean state on the next prompt.
      if (snap.busy.active) onCancel?.();
      if (value.length > 0) store.setInput("", 0);
      if (popup) store.closePopup();
      return;
    }

    // Readline-style cursor navigation. macOS Terminal.app and iTerm2 with
    // "Option as Meta" / "Send Ctrl+A/E for ⌘+←/→" send these sequences:
    //   Option+Left/Right  → ESC b / ESC f      (meta+b/meta+f)
    //   Cmd+Left/Right     → \x01 / \x05         (ctrl+a / ctrl+e)
    // Handled BEFORE the blanket `if (key.ctrl) return` guard below.
    if (key.meta && !key.return && (input === "b" || input === "\x1bb")) {
      store.setInput(value, prevWordPos(value, cursor)); return;
    }
    if (key.meta && !key.return && (input === "f" || input === "\x1bf")) {
      store.setInput(value, nextWordPos(value, cursor)); return;
    }
    if (key.ctrl && input === "x") {
      const text = store.latestOutputText();
      if (!text) {
        store.appendNotice("nothing to copy yet");
        return;
      }
      if (!copyToClipboard) {
        store.appendNotice("copy unavailable: no clipboard binding");
        return;
      }
      void copyToClipboard(text).then((r) => {
        if (r.ok) store.appendNotice(`copied ${text.length} chars · via ${r.via}`);
        else store.appendNotice(`copy failed: ${r.error ?? "unknown"}`);
      });
      return;
    }

    if (key.ctrl && input === "a") {
      store.setInput(value, lineStartPos(value, cursor)); return;
    }
    if (key.ctrl && input === "e") {
      store.setInput(value, lineEndPos(value, cursor)); return;
    }

    if (key.escape) {
      if (popup) { store.closePopup(); return; }
      onCancel?.();
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
      // Atomic deletion of paste placeholders. The "[Pasted text #N +M lines]"
      // token is treated as a single editable unit even if typed manually,
      // so one backspace at its trailing "]" wipes the entire token.
      const ph = placeholderEndingAt(value, cursor);
      if (ph) {
        const next = value.slice(0, ph.start) + value.slice(ph.end);
        setBuffer(next, ph.start);
        return;
      }
      const next = value.slice(0, cursor - 1) + value.slice(cursor);
      setBuffer(next, cursor - 1);
      return;
    }

    // Home/End → line start/end (also fires when iTerm2's "Natural Text Editing"
    // preset maps Cmd+Left/Right to Home/End).
    if (key.home) { store.setInput(value, lineStartPos(value, cursor)); return; }
    if (key.end)  { store.setInput(value, lineEndPos(value, cursor));   return; }

    // Word jump: Option+Left/Right (macOS) → meta+arrow.
    // Line jump: Ctrl+Left/Right and Super+Left/Right (Kitty protocol Cmd).
    // All horizontal motion is snap-corrected so a paste placeholder is
    // crossed as a single unit (cursor never lands strictly inside it).
    if (key.leftArrow) {
      if (key.meta) { store.setInput(value, snapCursor(value, prevWordPos(value, cursor), -1)); return; }
      if (key.ctrl || key.super) { store.setInput(value, lineStartPos(value, cursor)); return; }
      store.setInput(value, snapCursor(value, Math.max(0, cursor - 1), -1));
      return;
    }
    if (key.rightArrow) {
      if (key.meta) { store.setInput(value, snapCursor(value, nextWordPos(value, cursor), 1)); return; }
      if (key.ctrl || key.super) { store.setInput(value, lineEndPos(value, cursor)); return; }
      store.setInput(value, snapCursor(value, Math.min(value.length, cursor + 1), 1));
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

        const charSource = charTriggers.get(ch);
        if (charSource) {
          const triggerPos = curPos; // position where the new char now sits
          const okWordStart = atWordStart(next, triggerPos);
          const okOutsideQuote = !insideQuoteOrBacktick(next, triggerPos);
          if (okWordStart && okOutsideQuote) {
            curVal = next;
            curPos = newCursor;
            store.setInput(curVal, curPos);
            setHistIdx(null);
            store.openPopup({ sourceId: charSource.id, trigger: ch, query: "", anchor: triggerPos });
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
          const tp = cur.anchor;
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

  // Manually wrap the buffer so each visual row gets the "│   " gutter and
  // the cursor stays aligned. Letting Ink wrap the line text on its own
  // produces continuations without the prefix and a misplaced cursor.
  //
  // PREFIX = "│ ❯ " or "│   " (4 cols). Reserve 1 column past the wrapped
  // text so the inverse cursor block at end-of-line still fits inside the
  // terminal. Hence inner = cols - 4 - 1.
  const PREFIX_LEN = 4;
  const inner = Math.max(1, cols - PREFIX_LEN - 1);

  // First map the flat cursor offset to (logical line, col within that line).
  const logicalLines = value.split("\n");
  let logicalRow = 0;
  let logicalCol = cursor;
  for (let i = 0; i < logicalLines.length; i++) {
    const len = logicalLines[i]!.length;
    if (logicalCol <= len) { logicalRow = i; break; }
    logicalCol -= len + 1; // +1 for the consumed "\n"
    logicalRow = i + 1;
  }

  // Then break each logical line into visual rows of `inner` chars each.
  type VisualRow = { logicalIdx: number; rowIdx: number; startCol: number; text: string };
  const visualRows: VisualRow[] = [];
  for (let li = 0; li < logicalLines.length; li++) {
    const line = logicalLines[li]!;
    if (line.length === 0) {
      visualRows.push({ logicalIdx: li, rowIdx: 0, startCol: 0, text: "" });
      continue;
    }
    let off = 0, ri = 0;
    while (off < line.length) {
      visualRows.push({ logicalIdx: li, rowIdx: ri, startCol: off, text: line.slice(off, off + inner) });
      off += inner;
      ri++;
    }
  }

  // Find which visual row holds the cursor. For a non-last visual row of a
  // logical line, the cursor ranges over [startCol, startCol+inner); for the
  // last row of a line it can sit one past the last char (end-of-line).
  let visualCursorRow = 0;
  let visualCursorCol = 0;
  for (let i = 0; i < visualRows.length; i++) {
    const vr = visualRows[i]!;
    if (vr.logicalIdx !== logicalRow) continue;
    const next = visualRows[i + 1];
    const isLastOfLogical = !next || next.logicalIdx !== vr.logicalIdx;
    const local = logicalCol - vr.startCol;
    const inThis = isLastOfLogical
      ? (local >= 0 && local <= vr.text.length)
      : (local >= 0 && local < inner);
    if (inThis) { visualCursorRow = i; visualCursorCol = local; break; }
  }

  return (
    <Box flexDirection="column">
      <Text color={theme.promptColor}>{topLine}</Text>
      {visualRows.map((vr, i) => {
        const prefix = (vr.logicalIdx === 0 && vr.rowIdx === 0) ? "│ ❯ " : "│   ";
        if (i !== visualCursorRow) {
          return (
            <Box key={i}>
              <Text color={theme.promptColor}>{prefix}</Text>
              <Text color={theme.outputColor}>{vr.text.length === 0 ? " " : vr.text}</Text>
            </Box>
          );
        }
        const before = vr.text.slice(0, visualCursorCol);
        const at = vr.text[visualCursorCol] ?? " ";
        const after = vr.text.slice(visualCursorCol + 1);
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
      {ctrlCArmed && (
        <Text color={theme.noticeColor} dimColor>Press Ctrl-C again to exit</Text>
      )}
      {popup && <CompletionPopup popup={popup} noticeColor={theme.noticeColor} />}
    </Box>
  );
};
