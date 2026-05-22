import React, { useSyncExternalStore } from "react";
import { Box, Text } from "ink";
import type { TuiStore } from "../state/store.ts";
import type { UiTheme } from "llm-contracts/public";

export interface PromptBoxProps {
  store: TuiStore;
  theme: UiTheme;
}

export const PromptBox: React.FC<PromptBoxProps> = ({ store, theme }) => {
  const snap = useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => store.snapshot(),
  );
  const prompt = snap.prompt;
  if (!prompt) return null;

  if (prompt.kind === "text") {
    const { request, text } = prompt;
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.noticeColor} paddingX={1}>
        <Text color={theme.noticeColor} bold>{request.title}</Text>
        {request.body ? <Text>{request.body}</Text> : null}
        <Box marginTop={1}>
          <Text color={theme.promptColor}>{"▏ "}</Text>
          <Text>{text || (request.placeholder ?? "")}</Text>
        </Box>
        <Text color={theme.noticeColor} dimColor>
          {"Enter to submit · Esc to skip"}
        </Text>
      </Box>
    );
  }

  const { request, selectedIndex, expanded } = prompt;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.noticeColor} paddingX={1}>
      <Text color={theme.noticeColor} bold>{request.title}</Text>
      <Text>{request.body}</Text>
      <Box marginTop={1} flexDirection="column">
        {request.options.map((opt, i) => {
          const isSelected = i === selectedIndex;
          const indicator = isSelected ? "▸ " : "  ";
          const tabHint = opt.expandsTo && isSelected && !expanded ? "  (Tab for reason)" : "";
          return (
            <React.Fragment key={opt.id}>
              <Box>
                <Text color={isSelected ? theme.promptColor : undefined} bold={isSelected}>
                  {indicator}{opt.label}{tabHint}
                </Text>
              </Box>
              {expanded && expanded.id === opt.id ? (
                <Box flexDirection="column" marginLeft={4}>
                  <Box>
                    <Text>{(opt.expandsTo?.placeholder ?? "Reason") + ": "}</Text>
                    <Text>{expanded.text}</Text>
                    <Text color={theme.promptColor}>▏</Text>
                  </Box>
                  <Text color={theme.noticeColor} dimColor>
                    {"Enter to submit · Esc to collapse"}
                  </Text>
                </Box>
              ) : null}
            </React.Fragment>
          );
        })}
      </Box>
    </Box>
  );
};
