import React, { useSyncExternalStore } from "react";
import { Box, Text, useInput } from "ink";
import type { TuiStore, TranscriptLine } from "../state/store.ts";
import type { CompletionRegistry } from "../completion/registry.ts";
import type { TuiTheme } from "../theme/loader.ts";
import { SpinnerLine } from "./SpinnerLine.tsx";
import { StatusBar } from "./StatusBar.tsx";
import { InputBox } from "./InputBox.tsx";
import { ThinkingBox } from "./ThinkingBox.tsx";
import { ThoughtsBlock } from "./ThoughtsBlock.tsx";

export interface AppProps {
  store: TuiStore;
  registry: CompletionRegistry;
  triggers: Set<string>;
  theme: TuiTheme;
  onSubmit: (text: string) => void;
  onCtrlC?: () => void;
}

export const App: React.FC<AppProps> = ({ store, registry, triggers, theme, onSubmit, onCtrlC }) => {
  const snap = useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => store.snapshot(),
  );

  // Ctrl+R toggles the most recent Thoughts block. The InputBox handles
  // its own useInput; ink dispatches to all hooks, so a second hook here
  // for a chord that the input doesn't claim is safe.
  useInput((input, key) => {
    if (key.ctrl && (input === "r" || input === "R")) {
      store.toggleLatestThoughts();
    }
  });

  return (
    <Box flexDirection="column">
      {snap.transcript.map((e: TranscriptLine) => {
        if (e.kind === "user") {
          return (
            <Text key={e.id}>
              <Text color={theme.promptColor} bold>{"❯ "}</Text>
              <Text color={theme.outputColor} backgroundColor="#2a2a2a">{e.text}</Text>
            </Text>
          );
        }
        if (e.kind === "thoughts") {
          return (
            <ThoughtsBlock
              key={e.id}
              text={e.text}
              expanded={e.expanded ?? false}
              color={theme.noticeColor}
            />
          );
        }
        return (
          <Text key={e.id} color={e.kind === "notice" ? theme.noticeColor : theme.outputColor} dimColor={e.kind === "notice"}>
            {e.text}
          </Text>
        );
      })}
      {snap.busy.active && snap.liveThinking && (
        <ThinkingBox text={snap.liveThinking} color={theme.noticeColor} />
      )}
      {snap.busy.active && <SpinnerLine color={theme.busyColor} message={snap.busy.message} />}
      <InputBox
        store={store}
        registry={registry}
        triggers={triggers}
        theme={theme}
        onSubmit={onSubmit}
        onCtrlC={onCtrlC}
      />
      <StatusBar items={snap.status} color={theme.statusBarColor} />
    </Box>
  );
};
