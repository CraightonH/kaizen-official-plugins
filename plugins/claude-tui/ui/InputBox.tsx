import React, { useState, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import type { TuiStore } from "../state/store.ts";
import { handleSlash } from "../slash.ts";

export interface InputBoxProps {
  store: TuiStore;
  history: string[];
  onCtrlC?: () => void;
}

export const InputBox: React.FC<InputBoxProps> = ({ store, history, onCtrlC }) => {
  const [buffer, setBuffer] = useState("");
  const [cursor, setCursor] = useState(0);
  const [histIdx, setHistIdx] = useState<number | null>(null);

  const submit = useCallback(() => {
    const line = buffer;
    setBuffer("");
    setCursor(0);
    setHistIdx(null);
    if (handleSlash(line, store) === "swallow") return;
    store.submit(line);
  }, [buffer, store]);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      onCtrlC?.();
      return;
    }
    if (key.return && !key.shift) {
      submit();
      return;
    }
    if (key.return && key.shift) {
      setBuffer((b) => b.slice(0, cursor) + "\n" + b.slice(cursor));
      setCursor((c) => c + 1);
      return;
    }
    if (key.backspace || key.delete) {
      if (cursor === 0) return;
      setBuffer((b) => b.slice(0, cursor - 1) + b.slice(cursor));
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.leftArrow) {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.rightArrow) {
      setCursor((c) => Math.min(buffer.length, c + 1));
      return;
    }
    if (key.upArrow) {
      if (history.length === 0) return;
      const next = histIdx === null ? history.length - 1 : Math.max(0, histIdx - 1);
      setHistIdx(next);
      setBuffer(history[next] ?? "");
      setCursor((history[next] ?? "").length);
      return;
    }
    if (key.downArrow) {
      if (histIdx === null) return;
      const next = histIdx + 1;
      if (next >= history.length) {
        setHistIdx(null);
        setBuffer("");
        setCursor(0);
      } else {
        setHistIdx(next);
        setBuffer(history[next] ?? "");
        setCursor((history[next] ?? "").length);
      }
      return;
    }
    if (input && input.length > 0) {
      setBuffer((b) => b.slice(0, cursor) + input + b.slice(cursor));
      setCursor((c) => c + input.length);
    }
  });

  return (
    <Box borderStyle="round" borderColor="magenta" paddingX={1}>
      <Text color="magenta">❯ </Text>
      <Text>{buffer || " "}</Text>
    </Box>
  );
};
